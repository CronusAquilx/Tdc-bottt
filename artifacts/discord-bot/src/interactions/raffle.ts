import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType
} from "discord.js";
import { db, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildRaffleEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

// ── Raffle row helper ──────────────────────────────────────────────────────────
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
        new ButtonBuilder().setCustomId(`raffle:spin:${raffle.id}`).setLabel("🎰  Start Wheel  (Owner)").setStyle(ButtonStyle.Danger)
      )
    ] : [];

    await msg.edit({ embeds: [embed], components });
  } catch { /* ignore */ }
}

// ── Handle raffle buttons ──────────────────────────────────────────────────────
export async function handleRaffleButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  if (ns !== "raffle") return false;

  const raffleId = rest.join(":");

  // ── Enter raffle ────────────────────────────────────────────────────────────
  if (action === "enter") {
    await interaction.deferReply({ ephemeral: true });

    const r = await db.execute({ sql: "SELECT * FROM raffles WHERE id = ?", args: [raffleId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Raffle not found." }); return true; }
    const raffle = rowToRaffle(r.rows[0]);

    if (raffle.status !== "active") {
      await interaction.editReply({ content: "❌ This raffle has already ended." });
      return true;
    }

    // Check already entered
    const existing = await db.execute({
      sql: "SELECT 1 FROM raffle_entries WHERE raffle_id = ? AND user_id = ?",
      args: [raffleId, interaction.user.id]
    });
    if (existing.rows[0]) {
      await interaction.editReply({ content: "✅ You're already entered! Good luck 🍀" });
      return true;
    }

    await db.execute({
      sql: "INSERT INTO raffle_entries (raffle_id, user_id) VALUES (?, ?)",
      args: [raffleId, interaction.user.id]
    });

    const entryCount = await getEntryCount(raffleId);

    // Refresh the raffle embed with updated entry count
    if (interaction.guild) {
      await refreshRaffleMessage(raffle, interaction.guild, entryCount, "active");
    }

    await interaction.editReply({ content: `🎟️ You're in! **${entryCount}** ${entryCount === 1 ? "entry" : "entries"} so far. Good luck! 🍀` });
    return true;
  }

  // ── Spin the wheel ──────────────────────────────────────────────────────────
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

    // Pick winners
    const shuffled = [...entryIds].sort(() => Math.random() - 0.5);
    const winnerIds = shuffled.slice(0, winnerCount);

    // Atomic status update — prevents double-spin race conditions
    const updateResult = await db.execute({
      sql: "UPDATE raffles SET status = 'ended', winners = ?, ends_at = datetime('now') WHERE id = ? AND status = 'active'",
      args: [JSON.stringify(winnerIds), raffleId]
    });

    if (!updateResult.rowsAffected) {
      await interaction.editReply({ content: "❌ This raffle was already spun." });
      return true;
    }

    // Build wheel URL for the website
    const domain = process.env.REPLIT_DEV_DOMAIN ?? "";
    const wheelUrl = domain ? `https://${domain}/raffle/${raffleId}` : null;

    // --- Spinning animation ---
    if (interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(raffle.channel_id);
        if (ch?.isTextBased()) {
          const msgR = raffle.message_id ? await (ch as any).messages.fetch(raffle.message_id).catch(() => null) : null;

          const spinFrames = [
            "🎡 Spinning the wheel... 🎲",
            "🎡 Who's it gonna be? 👀",
            "🎡 Round and round... 🌀",
            "🎡 Almost there... ⚡",
            "🎡 Final spin... 🔥",
          ];

          for (const frame of spinFrames) {
            const spinEmbed = new EmbedBuilder()
              .setTitle("🎡  SPINNING THE WHEEL...")
              .setColor(0x9b59b6)
              .setDescription(
                `## ${raffle.title}\n\n${frame}\n\n*${entryCount} entries in the wheel...*` +
                (wheelUrl ? `\n\n🌐 [Watch the wheel spin live!](${wheelUrl})` : "")
              )
              .setFooter({ text: FOOTER });
            if (msgR) await msgR.edit({ embeds: [spinEmbed], components: [] });
            await new Promise(res => setTimeout(res, 700));
          }

          // Build winner announcement
          const winnerMentions = winnerIds.map(id => `<@${id}>`).join(", ");
          const prizes = raffle.prizes.length ? raffle.prizes : [raffle.title];
          const prizeLines = winnerIds.map((id, i) => {
            const prize = prizes[i] ?? prizes[prizes.length - 1] ?? raffle.title;
            return `🏆 <@${id}> — **${prize}**`;
          }).join("\n");

          const winnerDesc = `## ${raffle.title}\n\n${prizeLines}` +
            (wheelUrl ? `\n\n🌐 [View results on the website](${wheelUrl})` : "");

          const winnerEmbed = new EmbedBuilder()
            .setTitle("🎉  WE HAVE A WINNER!")
            .setColor(0xffd700)
            .setDescription(winnerDesc)
            .addFields(
              { name: "🎟️ Total Entries", value: `**${entryCount}**`,     inline: true },
              { name: "🏆 Winners",        value: `**${winnerCount}**`,    inline: true },
              { name: "🎁 Prizes",         value: prizes.join("\n") || raffle.title, inline: false }
            )
            .setFooter({ text: "東京ドリフトカスタム  ·  Congratulations! 🎉" })
            .setTimestamp();

          if (msgR) await msgR.edit({ embeds: [winnerEmbed], components: [] });

          // Ping the winners in the raffle channel
          const pingContent = `🎉 Congratulations ${winnerMentions}! You won the **${raffle.title}** raffle! 🏆` +
            (wheelUrl ? `\n🌐 ${wheelUrl}` : "");
          await (ch as any).send({ content: pingContent });
        }
      } catch { /* ignore */ }
    }

    await interaction.editReply({ content: `✅ Wheel spun! Winners: ${winnerIds.map(id => `<@${id}>`).join(", ")}` });
    return true;
  }

  return false;
}

// ── Handle raffle modal (create raffle) ────────────────────────────────────────
export async function handleRaffleModal(interaction: any): Promise<boolean> {
  if (!interaction.customId.startsWith("raffle:create")) return false;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const title       = interaction.fields.getTextInputValue("title");
  const description = interaction.fields.getTextInputValue("description");
  const prizesRaw   = interaction.fields.getTextInputValue("prizes");
  const winnersStr  = interaction.fields.getTextInputValue("winners");
  const durationStr = interaction.fields.getTextInputValue("duration");

  const winnerCount = Math.max(1, parseInt(winnersStr, 10) || 1);
  const prizes = prizesRaw.split("\n").map((p: string) => p.trim()).filter(Boolean);

  // Parse duration (e.g. "30m", "2h", "1d")
  let endsAt: string | null = null;
  const durationMatch = durationStr.trim().match(/^(\d+)(m|h|d)$/i);
  if (durationMatch) {
    const amount = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const ms = unit === "m" ? amount * 60000 : unit === "h" ? amount * 3600000 : amount * 86400000;
    endsAt = new Date(Date.now() + ms).toISOString().replace("T", " ").split(".")[0];
  }

  const config = await getGuildConfig(guild.id);
  const raffleChanId = config?.raffle_channel_id ?? interaction.channelId;

  const raffleId = randomUUID();
  await db.execute({
    sql: "INSERT INTO raffles (id, guild_id, channel_id, title, description, prizes, winner_count, ends_at, started_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [raffleId, guild.id, raffleChanId, title, description, JSON.stringify(prizes), winnerCount, endsAt, interaction.user.id]
  });

  // Post raffle embed
  try {
    const ch = await guild.channels.fetch(raffleChanId);
    if (ch?.isTextBased()) {
      const embed = buildRaffleEmbed({ id: raffleId, title, description, winner_count: winnerCount, ends_at: endsAt, entry_count: 0, status: "active", prizes });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`raffle:enter:${raffleId}`).setLabel("🎟️  Enter Raffle").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`raffle:spin:${raffleId}`).setLabel("🎰  Start Wheel  (Owner)").setStyle(ButtonStyle.Danger)
      );
      const msg = await (ch as any).send({ content: "@everyone 🎰 A new raffle has started!", embeds: [embed], components: [row] });
      await db.execute({ sql: "UPDATE raffles SET message_id = ? WHERE id = ?", args: [msg.id, raffleId] });
    }
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Failed to post raffle: ${err.message}` });
    return true;
  }

  await interaction.editReply({ content: `✅ Raffle **${title}** created in <#${raffleChanId}>!` });
  return true;
}

// ── Show create raffle modal ───────────────────────────────────────────────────
export async function showCreateRaffleModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder().setCustomId("raffle:create").setTitle("Create a Raffle");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("title").setLabel("Raffle Title").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. Car of the Week")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("description").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("What's the raffle about?")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("prizes").setLabel("Prize(s) — one per line").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("1st Place Prize\n2nd Place Prize\n...")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("winners").setLabel("Number of Winners").setStyle(TextInputStyle.Short).setRequired(true).setValue("1").setPlaceholder("1")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("duration").setLabel("Duration (30m / 2h / 1d — blank = manual)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("30m")
    )
  );
  await interaction.showModal(modal);
}
