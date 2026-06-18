import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder,
} from "discord.js";
import { db, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildRaffleEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { drawWheelBuffer, winnerRotation, spinFrameRotations } from "../lib/wheel.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

// ── Prize category presets ──────────────────────────────────────────────────────
const PRIZE_PRESETS: Record<string, { title: string; prizes: string }> = {
  car: {
    title: "Car Raffle",
    prizes: "1st Place — Supercar\n2nd Place — Sports Car\n3rd Place — Classic",
  },
  weapon: {
    title: "Weapon Raffle",
    prizes: "1st Place — Rare Weapon\n2nd Place — Standard Weapon\n3rd Place — Ammo Cache",
  },
  money: {
    title: "Money Raffle",
    prizes: "1st Place — $100,000\n2nd Place — $50,000\n3rd Place — $25,000",
  },
  custom: {
    title: "Raffle",
    prizes: "",
  },
};

// ── Raffle row helper ───────────────────────────────────────────────────────────
function rowToRaffle(row: unknown): {
  id: string; guild_id: string; channel_id: string; message_id: string | null;
  title: string; description: string; prizes: string[]; winner_count: number;
  ends_at: string | null; started_by: string; status: string; winners: string[];
} {
  const c = (i: number) => {
    if (Array.isArray(row)) return row[i];
    if (row && typeof row === "object") return (row as any)[i];
    return undefined;
  };
  return {
    id:           String(c(0) ?? ""),
    guild_id:     String(c(1) ?? ""),
    channel_id:   String(c(2) ?? ""),
    message_id:   c(3) ? String(c(3)) : null,
    title:        String(c(4) ?? ""),
    description:  String(c(5) ?? ""),
    prizes:       (() => { try { return JSON.parse(String(c(6) ?? "[]")); } catch { return []; } })(),
    winner_count: Number(c(7) ?? 1),
    ends_at:      c(8) ? String(c(8)) : null,
    started_by:   String(c(9) ?? ""),
    status:       String(c(10) ?? "active"),
    winners:      (() => { try { return JSON.parse(String(c(11) ?? "[]")); } catch { return []; } })(),
  };
}

async function getEntryCount(raffleId: string): Promise<number> {
  const r = await db.execute({ sql: "SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = ?", args: [raffleId] });
  return Number(r.rows[0]?.[0] ?? 0);
}

async function refreshRaffleMessage(raffle: ReturnType<typeof rowToRaffle>, guild: any, entryCount: number, status: string) {
  if (!raffle.message_id || !raffle.channel_id) return;
  try {
    const ch = await guild.channels.fetch(raffle.channel_id);
    if (!ch?.isTextBased()) return;
    const msg = await (ch as any).messages.fetch(raffle.message_id);
    const embed = buildRaffleEmbed({ ...raffle, entry_count: entryCount, status, prizes: raffle.prizes });
    const components = status === "active" ? [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`raffle:enter:${raffle.id}`).setLabel("🎟️  Enter Raffle").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`raffle:spin:${raffle.id}`).setLabel("🎡  Start Wheel  (Owner)").setStyle(ButtonStyle.Danger)
      )
    ] : [];
    await msg.edit({ embeds: [embed], components });
  } catch { /* ignore */ }
}

// ── Handle raffle buttons ───────────────────────────────────────────────────────
export async function handleRaffleButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  if (ns !== "raffle") return false;

  const raffleId = rest.join(":");

  // ── Prize type selection (must show modal immediately — no defer/reply before) ──
  if (action === "type") {
    const type = raffleId; // rest[0]
    const preset = PRIZE_PRESETS[type] ?? PRIZE_PRESETS.custom;

    const modal = new ModalBuilder()
      .setCustomId(`raffle:create:${type}`)
      .setTitle(`Create ${preset.title}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Raffle Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(preset.title)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("winners")
          .setLabel("Number of Winners")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("1")
          .setPlaceholder("1")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration (30m / 2h / 1d — blank=manual)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("e.g. 30m  /  2h  /  1d")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        (() => {
          const inp = new TextInputBuilder()
            .setCustomId("prizes")
            .setLabel("Prizes — one per line, edit as needed")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("1st Place — Prize\n2nd Place — Prize\n...");
          if (preset.prizes) inp.setValue(preset.prizes);
          return inp;
        })()
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description  (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("What is this raffle for?")
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  // ── Enter raffle ─────────────────────────────────────────────────────────────
  if (action === "enter") {
    await interaction.deferReply({ ephemeral: true });

    const r = await db.execute({ sql: "SELECT * FROM raffles WHERE id = ?", args: [raffleId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Raffle not found." }); return true; }
    const raffle = rowToRaffle(r.rows[0]);

    if (raffle.status !== "active") {
      await interaction.editReply({ content: "❌ This raffle has already ended." });
      return true;
    }

    const existing = await db.execute({
      sql: "SELECT 1 FROM raffle_entries WHERE raffle_id = ? AND user_id = ?",
      args: [raffleId, interaction.user.id]
    });
    if (existing.rows[0]) {
      await interaction.editReply({ content: "✅ You're already in! Good luck 🍀" });
      return true;
    }

    await db.execute({
      sql: "INSERT INTO raffle_entries (raffle_id, user_id) VALUES (?, ?)",
      args: [raffleId, interaction.user.id]
    });

    const entryCount = await getEntryCount(raffleId);
    if (interaction.guild) await refreshRaffleMessage(raffle, interaction.guild, entryCount, "active");

    await interaction.editReply({ content: `🎟️ You're in! **${entryCount}** ${entryCount === 1 ? "entry" : "entries"} so far. Good luck! 🍀` });
    return true;
  }

  // ── Spin the wheel ────────────────────────────────────────────────────────────
  if (action === "spin") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const r = await db.execute({ sql: "SELECT * FROM raffles WHERE id = ?", args: [raffleId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Raffle not found." }); return true; }
    const raffle = rowToRaffle(r.rows[0]);

    if (raffle.status !== "active") {
      await interaction.editReply({ content: "❌ This raffle has already been spun." });
      return true;
    }

    const entriesR = await db.execute({
      sql: "SELECT user_id FROM raffle_entries WHERE raffle_id = ?",
      args: [raffleId]
    });

    if (!entriesR.rows.length) {
      await interaction.editReply({ content: "❌ No one entered the raffle!" });
      return true;
    }

    const entryIds = entriesR.rows.map(row => String(row[0]));
    const entryCount = entryIds.length;
    const winnerCount = Math.min(raffle.winner_count, entryCount);

    const shuffled = [...entryIds].sort(() => Math.random() - 0.5);
    const winnerIds = shuffled.slice(0, winnerCount);

    // Atomic update — no double-spin
    const updateResult = await db.execute({
      sql: "UPDATE raffles SET status = 'ended', winners = ?, ends_at = datetime('now') WHERE id = ? AND status = 'active'",
      args: [JSON.stringify(winnerIds), raffleId]
    });
    if (!updateResult.rowsAffected) {
      await interaction.editReply({ content: "❌ This raffle was already spun." });
      return true;
    }

    // ── Wheel animation in Discord ──────────────────────────────────────────────
    if (interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(raffle.channel_id);
        if (ch?.isTextBased()) {
          const msgR = raffle.message_id
            ? await (ch as any).messages.fetch(raffle.message_id).catch(() => null)
            : null;

          // The first winner's index determines where the wheel lands
          const firstWinnerIdx = shuffled.indexOf(winnerIds[0]);
          const finalRot = winnerRotation(firstWinnerIdx, entryCount);
          const frames = spinFrameRotations(finalRot, 5);

          const spinTitles = [
            "🎡  SPINNING...",
            "🎡  ROUND AND ROUND...",
            "🎡  WHO'S IT GONNA BE?",
            "🎡  ALMOST THERE...",
            "🎡  FINAL SPIN...",
          ];

          // Send each spin frame as a wheel image
          for (let f = 0; f < frames.length - 1; f++) {
            const buf = drawWheelBuffer(entryCount, frames[f]);
            const file = new AttachmentBuilder(buf, { name: "wheel.png" });
            const spinEmbed = new EmbedBuilder()
              .setTitle(spinTitles[f] ?? "🎡  SPINNING...")
              .setColor(COLORS.raffle)
              .setDescription(`**${raffle.title}**\n\n*${entryCount} entries in the wheel...*`)
              .setImage("attachment://wheel.png")
              .setFooter({ text: FOOTER });

            if (msgR) await msgR.edit({ embeds: [spinEmbed], files: [file], components: [] });
            await new Promise(res => setTimeout(res, 900));
          }

          // Final frame — highlight all winner indices
          const winnerIndices = winnerIds.map(id => shuffled.indexOf(id));
          const finalBuf = drawWheelBuffer(entryCount, frames[frames.length - 1], winnerIndices);
          const finalFile = new AttachmentBuilder(finalBuf, { name: "wheel.png" });

          const prizes = raffle.prizes.length ? raffle.prizes : [raffle.title];

          // Winner lines — each winner gets their prize
          const prizeLines = winnerIds.map((id, i) => {
            const prize = prizes[i] ?? prizes[prizes.length - 1] ?? raffle.title;
            return `🏆 <@${id}> — **${prize}**`;
          }).join("\n");

          // Multiple-win callout if needed
          const multiNote = winnerCount > 1
            ? `\n\n*${winnerCount} winners selected!*`
            : "";

          const winnerEmbed = new EmbedBuilder()
            .setTitle("🎉  WE HAVE A WINNER!")
            .setColor(0xffd700)
            .setDescription(`**${raffle.title}**\n\n${prizeLines}${multiNote}`)
            .setImage("attachment://wheel.png")
            .addFields(
              { name: "🎟️ Total Entries", value: `**${entryCount}**`, inline: true },
              { name: "🏆 Winners",        value: `**${winnerCount}**`, inline: true },
              { name: "🎁 Prizes",         value: prizes.slice(0, winnerCount).join("\n") || raffle.title, inline: false }
            )
            .setFooter({ text: "東京ドリフトカスタム  ·  Congratulations! 🎉" })
            .setTimestamp();

          if (msgR) await msgR.edit({ embeds: [winnerEmbed], files: [finalFile], components: [] });

          const winnerMentions = winnerIds.map(id => `<@${id}>`).join(", ");
          await (ch as any).send({
            content: `🎉 Congratulations ${winnerMentions}! You won the **${raffle.title}** raffle! 🏆`
          });
        }
      } catch (err) {
        console.error("[Wheel] animation error:", err);
      }
    }

    await interaction.editReply({
      content: `✅ Wheel spun! Winners: ${winnerIds.map(id => `<@${id}>`).join(", ")}`
    });
    return true;
  }

  return false;
}

// ── Handle raffle modals ────────────────────────────────────────────────────────
export async function handleRaffleModal(interaction: any): Promise<boolean> {
  if (!interaction.customId.startsWith("raffle:create")) return false;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const title       = interaction.fields.getTextInputValue("title");
  const description = (interaction.fields.getTextInputValue("description") ?? "").trim();
  const prizesRaw   = interaction.fields.getTextInputValue("prizes");
  const winnersStr  = interaction.fields.getTextInputValue("winners");
  const durationStr = (interaction.fields.getTextInputValue("duration") ?? "").trim();

  const winnerCount = Math.max(1, parseInt(winnersStr, 10) || 1);
  const prizes = prizesRaw.split("\n").map((p: string) => p.trim()).filter(Boolean);

  // Trim prizes list to winner count — if someone put 3 prize lines but only 1 winner, only keep 1
  const effectivePrizes = prizes.slice(0, winnerCount);
  // If fewer prizes than winners, repeat last prize for remaining spots
  while (effectivePrizes.length < winnerCount && effectivePrizes.length > 0) {
    effectivePrizes.push(effectivePrizes[effectivePrizes.length - 1]);
  }

  // Parse duration: 30m / 2h / 1d / 1h30m
  let endsAt: string | null = null;
  if (durationStr) {
    let ms = 0;
    const parts = durationStr.matchAll(/(\d+)\s*(m|h|d)/gi);
    for (const p of parts) {
      const n = parseInt(p[1], 10);
      const u = p[2].toLowerCase();
      ms += u === "m" ? n * 60_000 : u === "h" ? n * 3_600_000 : n * 86_400_000;
    }
    if (ms > 0) endsAt = new Date(Date.now() + ms).toISOString().replace("T", " ").split(".")[0];
  }

  const config = await getGuildConfig(guild.id);
  const raffleChanId = config?.raffle_channel_id ?? interaction.channelId;

  const raffleId = randomUUID();
  await db.execute({
    sql: "INSERT INTO raffles (id, guild_id, channel_id, title, description, prizes, winner_count, ends_at, started_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [raffleId, guild.id, raffleChanId, title, description, JSON.stringify(effectivePrizes), winnerCount, endsAt, interaction.user.id]
  });

  try {
    const ch = await guild.channels.fetch(raffleChanId);
    if (ch?.isTextBased()) {
      const embed = buildRaffleEmbed({
        id: raffleId, title, description,
        winner_count: winnerCount, ends_at: endsAt,
        entry_count: 0, status: "active",
        prizes: effectivePrizes,
      });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`raffle:enter:${raffleId}`).setLabel("🎟️  Enter Raffle").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`raffle:spin:${raffleId}`).setLabel("🎡  Start Wheel  (Owner)").setStyle(ButtonStyle.Danger)
      );
      const msg = await (ch as any).send({
        content: "@everyone 🎡 A new raffle has started!",
        embeds: [embed],
        components: [row],
      });
      await db.execute({ sql: "UPDATE raffles SET message_id = ? WHERE id = ?", args: [msg.id, raffleId] });
    }
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Failed to post raffle: ${err.message}` });
    return true;
  }

  const timeNote = endsAt
    ? ` · ends <t:${Math.floor(new Date(endsAt).getTime() / 1000)}:R>`
    : " · manual spin";

  await interaction.editReply({
    content: `✅ Raffle **${title}** created in <#${raffleChanId}>${timeNote}!\n**${winnerCount}** winner(s)  ·  **${effectivePrizes.length}** prize(s)`
  });
  return true;
}

// ── Show raffle type selector (called from admin panel + raffle panel) ───────────
export async function showRaffleTypeSelector(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setTitle("🎡  Create a Raffle")
    .setColor(COLORS.raffle)
    .setDescription(
      "**Choose the prize category for this raffle.**\n\n" +
      "🚗 **Car** — vehicle prizes (Supercar, Sports Car, etc.)\n" +
      "🔫 **Weapon** — weapon prizes (Rare Weapon, etc.)\n" +
      "💰 **Money** — cash prize amounts\n" +
      "✏️ **Custom** — type your own prizes from scratch"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("raffle:type:car").setLabel("🚗  Car").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("raffle:type:weapon").setLabel("🔫  Weapon").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("raffle:type:money").setLabel("💰  Money").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("raffle:type:custom").setLabel("✏️  Custom").setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
}
