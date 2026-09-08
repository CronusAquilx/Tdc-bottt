import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, MessageFlags} from "discord.js";
import { db, getGuildConfig, getSetting, setSetting, checkpointDatabase } from "../db.js";
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
  minimum_sales: number; minimum_orders: number;
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
    minimum_sales: Number(c(13) ?? 0),
    minimum_orders: Number(c(14) ?? 0),
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

type PendingRaffle = {
  guildId: string;
  channelId: string;
  userId: string;
  title: string;
  description: string;
  prizes: string[];
  winnerCount: number;
  endsAt: string | null;
};

function pendingRaffleKey(token: string): string {
  return `raffle_pending:${token}`;
}

function parseMoneyInput(value: string): number {
  const parsed = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

async function getRaffleSales(userId: string, guildId: string): Promise<{ sales: number; orders: number }> {
  const resetTs = await getSetting("order_number_reset_ts");
  const r = await db.execute({
    sql: `SELECT COALESCE(SUM(total), 0), COUNT(*)
          FROM orders
          WHERE mechanic_id = ?
            AND (guild_id = ? OR guild_id = '')
            AND status IN ('complete', 'approved', 'paid')
            AND datetime(COALESCE(completed_at, created_at)) >= datetime(?)`,
    args: [userId, guildId, resetTs ?? "2000-01-01 00:00:00"]
  });
  return {
    sales: Number(r.rows[0]?.[0] ?? 0),
    orders: Number(r.rows[0]?.[1] ?? 0)
  };
}

async function createRaffle(
  guild: any,
  startedBy: string,
  pending: PendingRaffle,
  minimumSales: number,
  minimumOrders: number
): Promise<{ raffleId: string; channelId: string; effectivePrizes: string[]; endsAt: string | null }> {
  const raffleId = randomUUID();
  const effectivePrizes = pending.prizes.slice(0, pending.winnerCount);
  while (effectivePrizes.length < pending.winnerCount && effectivePrizes.length > 0) {
    effectivePrizes.push(effectivePrizes[effectivePrizes.length - 1]);
  }

  await db.execute({
    sql: `INSERT INTO raffles
          (id, guild_id, channel_id, title, description, prizes, winner_count, ends_at, started_by, minimum_sales, minimum_orders)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      raffleId, pending.guildId, pending.channelId, pending.title, pending.description,
      JSON.stringify(effectivePrizes), pending.winnerCount, pending.endsAt, startedBy,
      minimumSales, minimumOrders
    ]
  });
  await checkpointDatabase();

  try {
    const ch = await guild.channels.fetch(pending.channelId);
    if (ch?.isTextBased()) {
      const embed = buildRaffleEmbed({
        id: raffleId,
        title: pending.title,
        description: pending.description,
        winner_count: pending.winnerCount,
        ends_at: pending.endsAt,
        entry_count: 0,
        status: "active",
        prizes: effectivePrizes,
        minimum_sales: minimumSales,
        minimum_orders: minimumOrders
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
      await checkpointDatabase();
    }
  } catch (err) {
    // Keep the database record: the raffle can be recovered/reposted instead
    // of disappearing if Discord is temporarily unavailable.
    throw new Error(`Raffle saved, but Discord posting failed: ${err instanceof Error ? err.message : "unknown Discord error"}`);
  }

  return { raffleId, channelId: pending.channelId, effectivePrizes, endsAt: pending.endsAt };
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

  // Optional second step for entry requirements. This must show the modal as
  // the first Discord response to the button interaction.
  if (action === "rules") {
    const token = raffleId;
    const pendingRaw = await getSetting(pendingRaffleKey(token));
    if (!pendingRaw) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ This raffle setup expired. Start again from Create Raffle." });
      return true;
    }
    const pending = JSON.parse(pendingRaw) as PendingRaffle;
    if (pending.userId !== interaction.user.id) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ This raffle setup belongs to another staff member." });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`raffle:rules:${token}`)
      .setTitle("Raffle Entry Requirements");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("minimum_sales")
          .setLabel("Minimum sales this pay period ($)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("Example: 10000")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("minimum_orders")
          .setLabel("Minimum completed orders this pay period")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("Example: 3")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "finish" || action === "cancel") {
    await interaction.deferUpdate();
    const token = raffleId;
    const pendingRaw = await getSetting(pendingRaffleKey(token));
    if (!pendingRaw) {
      await interaction.editReply({ content: "❌ This raffle setup expired. Start again from Create Raffle.", embeds: [], components: [] });
      return true;
    }
    const pending = JSON.parse(pendingRaw) as PendingRaffle;
    if (pending.userId !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This raffle setup belongs to another staff member.", embeds: [], components: [] });
      return true;
    }
    await db.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: [pendingRaffleKey(token)] });
    await checkpointDatabase();
    if (action === "cancel") {
      await interaction.editReply({ content: "✅ Raffle creation cancelled.", embeds: [], components: [] });
      return true;
    }
    try {
      const created = await createRaffle(interaction.guild, interaction.user.id, pending, 0, 0);
      const timeNote = created.endsAt
        ? ` · ends <t:${Math.floor(new Date(created.endsAt).getTime() / 1000)}:R>`
        : " · manual spin";
      await interaction.editReply({
        content: `✅ Raffle **${pending.title}** created in <#${created.channelId}>${timeNote}!\n**${pending.winnerCount}** winner(s) · open entry`,
        embeds: [],
        components: []
      });
    } catch (err: any) {
      await interaction.editReply({ content: `⚠️ ${err?.message ?? "Raffle could not be posted."}`, embeds: [], components: [] });
    }
    return true;
  }

  // ── Enter raffle ─────────────────────────────────────────────────────────────
  if (action === "enter") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const r = await db.execute({ sql: "SELECT * FROM raffles WHERE id = ?", args: [raffleId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Raffle not found." }); return true; }
    const raffle = rowToRaffle(r.rows[0]);

    if (raffle.status !== "active") {
      await interaction.editReply({ content: "❌ This raffle has already ended." });
      return true;
    }

    if (raffle.ends_at && new Date(raffle.ends_at).getTime() <= Date.now()) {
      await db.execute({ sql: "UPDATE raffles SET status = 'ended' WHERE id = ? AND status = 'active'", args: [raffleId] });
      await checkpointDatabase();
      await refreshRaffleMessage(raffle, interaction.guild, await getEntryCount(raffleId), "ended");
      await interaction.editReply({ content: "❌ This raffle has ended." });
      return true;
    }

    const eligibility = await getRaffleSales(interaction.user.id, raffle.guild_id);
    const missingSales = Math.max(0, raffle.minimum_sales - eligibility.sales);
    const missingOrders = Math.max(0, raffle.minimum_orders - eligibility.orders);
    if (missingSales > 0 || missingOrders > 0) {
      const requirementLines = [
        raffle.minimum_sales > 0 ? `Sales: **$${eligibility.sales.toLocaleString()} / $${raffle.minimum_sales.toLocaleString()}**` : "",
        raffle.minimum_orders > 0 ? `Orders: **${eligibility.orders} / ${raffle.minimum_orders}**` : ""
      ].filter(Boolean).join("\n");
      await interaction.editReply({ content: `❌ You don't meet the entry requirement yet.\n${requirementLines}` });
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
    await checkpointDatabase();

    const entryCount = await getEntryCount(raffleId);
    if (interaction.guild) await refreshRaffleMessage(raffle, interaction.guild, entryCount, "active");

    // Get display name (server nickname → global display name → username)
    const displayName: string =
      (interaction.member as any)?.displayName ??
      interaction.user.displayName ??
      interaction.user.username;

    // Post public entry notification in the raffle channel
    if (interaction.guild && raffle.channel_id) {
      try {
        const ch = await interaction.guild.channels.fetch(raffle.channel_id);
        if (ch?.isTextBased()) {
          await (ch as any).send({
            content: `🎟️ **${displayName}** just entered the **${raffle.title}** raffle!  *(${entryCount} ${entryCount === 1 ? "entry" : "entries"} total)*`
          });
        }
      } catch { /* ignore */ }
    }

    await interaction.editReply({ content: `✅ You're in, **${displayName}**! **${entryCount}** ${entryCount === 1 ? "entry" : "entries"} so far. Good luck! 🍀` });
    return true;
  }

  // ── Spin the wheel ────────────────────────────────────────────────────────────
  if (action === "spin") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    await checkpointDatabase();

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
          const frames = spinFrameRotations(finalRot);

          const spinTitles = [
            "🎡  SPINNING...",
            "🎡  ROUND AND ROUND...",
            "🎡  WHO'S IT GONNA BE? 👀",
            "🎡  ALMOST THERE... ⚡",
            "🎡  FINAL SPIN... 🔥",
          ];

          // Send each spin frame — unique filename per frame avoids Discord CDN caching
          for (let f = 0; f < frames.length - 1; f++) {
            const fname = `wheel_s${f}.png`;
            const buf = drawWheelBuffer(entryCount, frames[f]);
            const file = new AttachmentBuilder(buf, { name: fname });
            const spinEmbed = new EmbedBuilder()
              .setTitle(spinTitles[f] ?? "🎡  SPINNING...")
              .setColor(COLORS.raffle)
              .setDescription(`**${raffle.title}**\n\n*${entryCount} entries in the wheel...*`)
              .setImage(`attachment://${fname}`)
              .setFooter({ text: FOOTER });

            if (msgR) await msgR.edit({ embeds: [spinEmbed], files: [file], components: [] });
            await new Promise(res => setTimeout(res, 950));
          }

          // Final frame — highlight all winner indices
          const winnerIndices = winnerIds.map(id => shuffled.indexOf(id));
          const finalBuf = drawWheelBuffer(entryCount, frames[frames.length - 1], winnerIndices);
          const finalFile = new AttachmentBuilder(finalBuf, { name: "wheel_winner.png" });

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
            .setImage("attachment://wheel_winner.png")
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
  if (interaction.customId.startsWith("raffle:rules:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const token = interaction.customId.split(":")[2];
    const pendingRaw = await getSetting(pendingRaffleKey(token));
    if (!pendingRaw) {
      await interaction.editReply({ content: "❌ This raffle setup expired. Start again from Create Raffle." });
      return true;
    }
    const pending = JSON.parse(pendingRaw) as PendingRaffle;
    if (pending.userId !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This raffle setup belongs to another staff member." });
      return true;
    }
    const minimumSales = parseMoneyInput(interaction.fields.getTextInputValue("minimum_sales") ?? "");
    const minimumOrders = Math.max(0, parseInt(interaction.fields.getTextInputValue("minimum_orders") ?? "", 10) || 0);
    await db.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: [pendingRaffleKey(token)] });
    await checkpointDatabase();
    try {
      const created = await createRaffle(interaction.guild, interaction.user.id, pending, minimumSales, minimumOrders);
      const rules = [
        minimumSales > 0 ? `$${minimumSales.toLocaleString()} sales` : "",
        minimumOrders > 0 ? `${minimumOrders} completed order(s)` : ""
      ].filter(Boolean).join(" + ") || "open entry";
      await interaction.editReply({
        content: `✅ Raffle **${pending.title}** created in <#${created.channelId}>!\n**${pending.winnerCount}** winner(s) · requirement: **${rules} this pay period**`
      });
    } catch (err: any) {
      await interaction.editReply({ content: `⚠️ ${err?.message ?? "Raffle could not be posted."}` });
    }
    return true;
  }

  if (!interaction.customId.startsWith("raffle:create")) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild!;
  const title       = interaction.fields.getTextInputValue("title");
  const description = (interaction.fields.getTextInputValue("description") ?? "").trim();
  const prizesRaw   = interaction.fields.getTextInputValue("prizes");
  const winnersStr  = interaction.fields.getTextInputValue("winners");
  const durationStr = (interaction.fields.getTextInputValue("duration") ?? "").trim();

  const winnerCount = Math.max(1, parseInt(winnersStr, 10) || 1);
  const prizes = prizesRaw.split("\n").map((p: string) => p.trim()).filter(Boolean);

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

  const token = randomUUID();
  const pending: PendingRaffle = {
    guildId: guild.id,
    channelId: raffleChanId,
    userId: interaction.user.id,
    title,
    description,
    prizes,
    winnerCount,
    endsAt
  };
  await setSetting(pendingRaffleKey(token), JSON.stringify(pending));
  await checkpointDatabase();

  const setupEmbed = new EmbedBuilder()
    .setTitle("🎟️  Raffle Entry Rules")
    .setColor(COLORS.raffle)
    .setDescription(
      `**${title}** is ready to publish in <#${raffleChanId}>.\n\n` +
      "Choose whether anyone can enter or require crew members to hit a sales target. " +
      "Sales means total order revenue this pay period — not commission."
    )
    .setFooter({ text: FOOTER });
  const setupRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`raffle:finish:${token}`).setLabel("🎟️ Open Entry").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`raffle:rules:${token}`).setLabel("📈 Set Sales Rules").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`raffle:cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({ embeds: [setupEmbed], components: [setupRow] });
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

  await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [row] });
}
