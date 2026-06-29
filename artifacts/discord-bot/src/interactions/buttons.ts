import {
  ButtonInteraction, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { db, getProfile, getGuildConfig, getUserRole, rowToOrder, rowToTimeclock, getSetting, setSetting, nextOrderNumber } from "../db.js";
import { requireRole, detectUserRoleLevel } from "../lib/roles.js";
import { buildOrderEmbed, buildClockInEmbed, buildClockOutEmbed, buildDraftEmbed, buildPayoutEmbed, buildDashboardEmbed, statusEmoji, COLORS, money } from "../lib/embeds.js";
import { randomUUID, weekStart, paginate } from "../lib/utils.js";
import { warnedMechanics, stayedIn } from "../lib/warnState.js";
import { autoClockOut } from "../lib/autoClockOut.js";
import { processPayall, buildPayallSummaryEmbed } from "../commands/payall.js";
import { postOrderPanel } from "./orderpanel.js";
import { getCommissionData, mainDraftButtonRows } from "./draftbuttons.js";
import { logEvent } from "../lib/eventLog.js";

/** SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" with no Z.
 *  Node.js treats this as LOCAL time — parse as UTC explicitly. */
function parseUtc(s: string): number {
  if (!s) return 0;
  const norm = s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + "Z";
  return new Date(norm).getTime();
}

/** After any clock-out, edit the idle-warning message to remove its buttons
 *  so mechanics can't click "Stay Clocked In" on a closed shift. */
async function clearWarnMessage(
  entry: { id: string; warn_msg_id: string | null; warn_chan_id: string | null },
  client: import("discord.js").Client
) {
  const mem    = warnedMechanics.get(entry.id);
  const msgId  = mem?.msgId  ?? entry.warn_msg_id;
  const chanId = mem?.chanId ?? entry.warn_chan_id;
  if (!msgId || !chanId) return;
  try {
    const ch = await client.channels.fetch(chanId).catch(() => null);
    if (ch && ch.isTextBased()) {
      const msg = await (ch as any).messages.fetch(msgId).catch(() => null);
      if (msg) await msg.edit({ components: [] });
    }
  } catch { /* ignore — DM closed or message deleted */ }
}

export async function handleButton(interaction: ButtonInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const id = rest.join(":");

  // ── Clock-warning: Stay Clocked In ────────────────────────────────────────
  if (ns === "clockwarn" && action === "stayin") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tcId = id;

    // Verify this timeclock entry exists and belongs to the user clicking
    const tcR = await db.execute({ sql: "SELECT mechanic_id FROM timeclock WHERE id = ?", args: [tcId] });
    if (!tcR.rows[0]) {
      // Entry doesn't exist — remove buttons from the warning message so it can't be clicked again
      try { await interaction.message.edit({ content: "ℹ️ This warning is no longer active.", components: [] }); } catch { /* ignore */ }
      await interaction.editReply({ content: "ℹ️ That shift no longer exists." });
      return;
    }
    const ownerId = String(tcR.rows[0][0] ?? "");
    if (ownerId !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This warning isn't for you." });
      return;
    }

    // Clear warn state and record stay-in time — persisted to DB so it survives restarts
    warnedMechanics.delete(tcId);
    await db.execute({
      sql: "UPDATE timeclock SET warned_at = NULL, stayed_in_at = datetime('now') WHERE id = ?",
      args: [tcId]
    }).catch(() => {});

    // Disable the warning message buttons using interaction.message directly
    // (works even after a bot restart when warnedMechanics is empty)
    try { await interaction.message.edit({ content: `✅ <@${interaction.user.id}> stayed clocked in.`, components: [] }); } catch { /* ignore */ }

    await interaction.editReply({ content: "✅ Got it — you're still clocked in! Keep up the good work." });
    return;
  }

  // ── Clock-warning: Clock Out Now ──────────────────────────────────────────
  if (ns === "clockwarn" && action === "clockout") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tcId = id;

    // Find the timeclock entry — also fetch warned_at (index 11) for stale-shift detection
    const tcR = await db.execute({
      sql: "SELECT id, mechanic_id, clock_in_time, clock_out_time, duration_minutes, approved_by, status, notes, created_at, clock_message_id, clock_channel_id, warned_at FROM timeclock WHERE id = ?",
      args: [tcId]
    });
    if (!tcR.rows[0]) {
      try { await interaction.message.edit({ content: "ℹ️ This warning is no longer active.", components: [] }); } catch { /* ignore */ }
      await interaction.editReply({ content: "ℹ️ That shift no longer exists." });
      return;
    }
    const entry = rowToTimeclock(tcR.rows[0]);
    const warnedAtRaw = tcR.rows[0][11] ? String(tcR.rows[0][11]) : null;

    if (entry.clock_out_time) {
      // Already clocked out — remove buttons so it stops showing
      try { await interaction.message.edit({ content: "✅ Already clocked out.", components: [] }); } catch { /* ignore */ }
      await interaction.editReply({ content: "ℹ️ You're already clocked out." });
      return;
    }
    if (entry.mechanic_id !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This isn't your timeclock entry." }); return;
    }

    // Clear warn state — both in-memory and in DB
    warnedMechanics.delete(tcId);
    await db.execute({ sql: "UPDATE timeclock SET warned_at = NULL WHERE id = ?", args: [tcId] }).catch(() => {});

    // Disable warning message buttons
    try { await interaction.message.edit({ content: `🔴 <@${interaction.user.id}> clocked out.`, components: [] }); } catch { /* ignore */ }

    await autoClockOut(
      interaction.client,
      interaction.guild,
      tcId,
      entry.mechanic_id,
      entry.clock_in_time,
      entry.clock_message_id ?? null,
      entry.clock_channel_id ?? null
    );

    // Calculate displayed duration — cap at warned_at + 30 min buffer if this was a stale shift
    // (prevents showing "27 hours" when the shift should have been auto-clocked-out long ago)
    const clockInMs  = parseUtc(entry.clock_in_time);
    const warnedAtMs = warnedAtRaw ? parseUtc(warnedAtRaw) : 0;
    const realMins   = (Date.now() - clockInMs) / 60000;
    // If shift was warned and button clicked more than 35 min after the warning,
    // show duration as of (warned_at + 30 min) — the expected auto-out window
    const WARN_MINS     = 120;
    const AUTO_OUT_MINS = 30;
    let displayMins = realMins;
    if (warnedAtMs > 0 && realMins > WARN_MINS + AUTO_OUT_MINS + 10) {
      displayMins = (warnedAtMs + AUTO_OUT_MINS * 60000 - clockInMs) / 60000;
      if (displayMins < 1) displayMins = realMins; // safety fallback
    }
    const hrs = Math.floor(displayMins / 60);
    const m = Math.round(displayMins % 60);
    await interaction.editReply({ content: `✅ Clocked out! **${hrs}h ${m}m**` });
    return;
  }

  // ── Clock In then immediately start a New Order (from the "clock in required" prompt) ──
  if (ns === "clockin" && action === "then" && rest[0] === "order") {
    await interaction.deferUpdate();

    // Atomic insert — prevents race condition
    const tcId = randomUUID();
    const inserted = await db.execute({
      sql: `INSERT INTO timeclock (id, mechanic_id, clock_in_time, guild_id)
            SELECT ?, ?, datetime('now'), ?
            WHERE NOT EXISTS (SELECT 1 FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL)`,
      args: [tcId, interaction.user.id, interaction.guild?.id ?? "", interaction.user.id]
    });

    // If already clocked in — that's fine, proceed to new order
    const effectiveTcId = inserted.rowsAffected ? tcId : null;

    if (effectiveTcId) {
      // Post clock-in embed to clock LOGS channel
      await db.execute({ sql: "UPDATE profiles SET status = 'online' WHERE discord_id = ?", args: [interaction.user.id] });
      const profile = await getProfile(interaction.user.id);
      const displayName = profile?.display_name
        ?? (interaction.member as any)?.displayName
        ?? interaction.user.globalName
        ?? interaction.user.username;
      const tcR = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
      const entry = rowToTimeclock(tcR.rows[0]);
      const clockEmbed = buildClockInEmbed(displayName, entry.clock_in_time);

      const CLOCK_LOG_CHANNEL = "1519941057616412832";
      if (interaction.guild) {
        const config = await getGuildConfig(interaction.guild.id);
        const logChanId = config?.clocklog_channel_id ?? config?.timeclock_channel_id ?? CLOCK_LOG_CHANNEL;
        try {
          const ch = await interaction.guild.channels.fetch(logChanId);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({ embeds: [clockEmbed] });
            await db.execute({
              sql: "UPDATE timeclock SET clock_message_id = ?, clock_channel_id = ? WHERE id = ?",
              args: [msg.id, ch.id, tcId]
            });
          }
        } catch { /* ignore */ }
      }
    }

    // Immediately open the new order draft
    const guildId = interaction.guildId ?? "";
    const roleLevel = await detectUserRoleLevel(interaction);
    const newOrderId = randomUUID();

    // Insert with retry on UNIQUE constraint (rare race on order_number)
    let orderNumber = await nextOrderNumber();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.execute({
          sql: "INSERT INTO orders (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes, role_level) VALUES (?, ?, ?, ?, 'draft', '[]', 0, 0, 0, '', ?)",
          args: [newOrderId, orderNumber, interaction.user.id, guildId, roleLevel]
        });
        break;
      } catch (err: any) {
        if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" && attempt < 4) {
          orderNumber = await nextOrderNumber();
          continue;
        }
        throw err;
      }
    }

    // Log the order creation
    logEvent({
      kind: "order_created",
      guildId,
      userId: interaction.user.id,
      userName: interaction.user.username,
      orderId: newOrderId,
      orderNumber
    });

    const [catalogStr, draft] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [newOrderId] }).then(r => rowToOrder(r.rows[0]))
    ]);
    const commData = await getCommissionData(interaction.user.id, guildId, roleLevel);
    let catalog: any = {};
    try { catalog = JSON.parse(catalogStr ?? "{}"); } catch { /* use empty */ }
    const categories: string[] = Array.isArray(catalog.categories) && catalog.categories.length > 0
      ? catalog.categories : [];

    if (categories.length === 0) {
      await interaction.editReply({ content: "⚠️ No service catalog is set up yet. Ask a manager to configure it with `/settings`." });
      return;
    }

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${newOrderId}`)
      .setPlaceholder("Pick a service category...")
      .addOptions(categories.map((cat: string) => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const crewCutInfo = commData.crewCut > 0 || ["trainer","manager","owner"].includes(roleLevel)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;

    await interaction.editReply({
      embeds: [buildDraftEmbed(draft, commData.weekCommission, commData.rate, crewCutInfo)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(newOrderId)
      ]
    });
    return;
  }

  // ── Clock In from order embed (toggles to Clock Out) ─────────────────────
  if (ns === "clockin" && action === "order") {
    await interaction.deferUpdate();

    // Atomic insert — prevents race condition where two clicks both pass a SELECT check
    const tcId = randomUUID();
    const inserted = await db.execute({
      sql: `INSERT INTO timeclock (id, mechanic_id, clock_in_time, guild_id)
            SELECT ?, ?, datetime('now'), ?
            WHERE NOT EXISTS (SELECT 1 FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL)`,
      args: [tcId, interaction.user.id, interaction.guild?.id ?? "", interaction.user.id]
    });
    if (!inserted.rowsAffected) {
      const activeRow = await db.execute({
        sql: "SELECT clock_in_time FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
        args: [interaction.user.id]
      });
      const sinceTs = activeRow.rows[0]
        ? ` (clocked in <t:${Math.floor(new Date(String(activeRow.rows[0][0])).getTime() / 1000)}:R>)`
        : "";
      const clockOutBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("clockout:order").setLabel("🔴 Clock Out Now").setStyle(ButtonStyle.Danger)
      );
      // Also update the order embed's buttons so they reflect the real clock state
      try {
        const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`orderpay:start:${interaction.user.id}`)
            .setLabel("💸  Pay")
            .setStyle(ButtonStyle.Primary)
        );
        await interaction.message.edit({
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId("order:newpanel").setLabel("📋  New Order").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId("clockout:order").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger)
            ),
            payRow
          ]
        });
      } catch { /* message may be too old to edit */ }
      await interaction.followUp({
        content: `⚠️ **You're already clocked in!**${sinceTs} Clock out first.`,
        components: [clockOutBtn],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Post clock-in embed to clock LOGS channel (not the panel channel)
    await db.execute({ sql: "UPDATE profiles SET status = 'online' WHERE discord_id = ?", args: [interaction.user.id] });
    const profile = await getProfile(interaction.user.id);
    const displayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const tcR = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
    const entry = rowToTimeclock(tcR.rows[0]);
    const clockEmbed = buildClockInEmbed(displayName, entry.clock_in_time);

    const CLOCK_LOG_FALLBACK = "1519941057616412832";
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      const logChanId = config?.clocklog_channel_id ?? config?.timeclock_channel_id ?? CLOCK_LOG_FALLBACK;
      try {
        const ch = await interaction.guild.channels.fetch(logChanId);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).send({ embeds: [clockEmbed] });
          await db.execute({
            sql: "UPDATE timeclock SET clock_message_id = ?, clock_channel_id = ? WHERE id = ?",
            args: [msg.id, ch.id, tcId]
          });
        }
      } catch { /* ignore */ }
    }

    // Toggle button to Clock Out, preserve Pay row
    const clockOutRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("order:newpanel").setLabel("📋  New Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("clockout:order").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger)
    );
    const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`orderpay:start:${interaction.user.id}`)
        .setLabel("💸  Pay")
        .setStyle(ButtonStyle.Primary)
    );
    await interaction.message.edit({ components: [clockOutRow, payRow] });
    await interaction.followUp({ content: "✅ Clocked in!", flags: MessageFlags.Ephemeral });
    return;
  }

  // ── Clock Out from order embed (toggles to Clock In) ─────────────────────
  if (ns === "clockout" && action === "order") {
    await interaction.deferUpdate();

    const active = await db.execute({
      sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1",
      args: [interaction.user.id]
    });
    if (!active.rows[0]) {
      await interaction.followUp({ content: "❌ You're not clocked in!", flags: MessageFlags.Ephemeral });
      const clockInRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("order:newpanel").setLabel("📋  New Order").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("clockin:order").setLabel("🟢  Clock In").setStyle(ButtonStyle.Primary)
      );
      const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`orderpay:start:${interaction.user.id}`)
          .setLabel("💸  Pay")
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.message.edit({ components: [clockInRow, payRow] });
      return;
    }

    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - parseUtc(entry.clock_in_time)) / 60000;

    await db.execute({
      sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', stayed_in_at = NULL, warned_at = NULL WHERE id = ?",
      args: [mins, entry.id]
    });
    await db.execute({
      sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?",
      args: [mins / 60, entry.mechanic_id]
    });
    // Clear any in-memory warn/stay state for this shift and remove warning buttons
    warnedMechanics.delete(entry.id);
    stayedIn.delete(entry.mechanic_id);
    await clearWarnMessage(entry, interaction.client);

    // Edit original clock-in message or post new clock-out
    const profile = await getProfile(interaction.user.id);
    const displayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [entry.id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const ordersThisShiftA = await db.execute({
      sql: "SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?",
      args: [interaction.user.id, entry.clock_in_time]
    });
    const clockEmbed = buildClockOutEmbed(displayName, updated.clock_in_time, updated.clock_out_time!, mins, Number(ordersThisShiftA.rows[0]?.[0] ?? 0));

    if (interaction.guild && updated.clock_message_id && updated.clock_channel_id) {
      try {
        const ch = await interaction.guild.channels.fetch(updated.clock_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(updated.clock_message_id).catch(() => null);
          if (msg) await msg.edit({ embeds: [clockEmbed] });
          else await (ch as any).send({ embeds: [clockEmbed] });
        }
      } catch { /* ignore */ }
    }

    // Toggle button to Clock In, preserve Pay row
    const hrs = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    const clockInRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("order:newpanel").setLabel("📋  New Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("clockin:order").setLabel("🟢  Clock In").setStyle(ButtonStyle.Primary)
    );
    const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`orderpay:start:${interaction.user.id}`)
        .setLabel("💸  Pay")
        .setStyle(ButtonStyle.Primary)
    );
    await interaction.message.edit({ components: [clockInRow, payRow] });
    await interaction.followUp({ content: `✅ Clocked out! **${hrs}h ${m}m**`, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── Clock In from panel ────────────────────────────────────────────────────
  if (ns === "clockin" && action === "panel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Atomic insert — only inserts if no active shift exists (prevents race condition)
    const tcId = randomUUID();
    const inserted = await db.execute({
      sql: `INSERT INTO timeclock (id, mechanic_id, clock_in_time, guild_id)
            SELECT ?, ?, datetime('now'), ?
            WHERE NOT EXISTS (SELECT 1 FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL)`,
      args: [tcId, interaction.user.id, interaction.guild?.id ?? "", interaction.user.id]
    });

    if (!inserted.rowsAffected) {
      // Already clocked in — show clock-out button so they can immediately clock out
      const activeRow = await db.execute({
        sql: "SELECT clock_in_time FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
        args: [interaction.user.id]
      });
      const sinceTs = activeRow.rows[0]
        ? `\n> Clocked in <t:${Math.floor(new Date(String(activeRow.rows[0][0])).getTime() / 1000)}:R>`
        : "";
      const clockOutBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("clockout:panel").setLabel("🔴  Clock Out Now").setStyle(ButtonStyle.Danger)
      );
      await interaction.editReply({
        content: `⚠️ **You're already clocked in!**${sinceTs}\n\nClick **Clock Out Now** if you want to end your shift.`,
        components: [clockOutBtn]
      });
      return;
    }
    await db.execute({ sql: "UPDATE profiles SET status = 'online' WHERE discord_id = ?", args: [interaction.user.id] });
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
    const entry = rowToTimeclock(r.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const displayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const embed = buildClockInEmbed(displayName, entry.clock_in_time);

    // Post to the clock LOGS channel — always use the correct log channel
    const CLOCK_LOG_FALLBACK_PANEL = "1519941057616412832";
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      const logChanId = config?.clocklog_channel_id ?? config?.timeclock_channel_id ?? CLOCK_LOG_FALLBACK_PANEL;
      try {
        const ch = await interaction.guild.channels.fetch(logChanId);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).send({ embeds: [embed] });
          await db.execute({
            sql: "UPDATE timeclock SET clock_message_id = ?, clock_channel_id = ? WHERE id = ?",
            args: [msg.id, ch.id, tcId]
          });
        }
      } catch { /* ignore */ }
    }

    const unixTs = Math.floor(parseUtc(entry.clock_in_time) / 1000);
    await interaction.editReply({ content: `✅ **Clocked in!** <t:${unixTs}:t>` } as any);
    return;
  }

  // ── Clock Out from panel ───────────────────────────────────────────────────
  if (ns === "clockout" && action === "panel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const active = await db.execute({
      sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1",
      args: [interaction.user.id]
    });
    if (!active.rows[0]) {
      await interaction.editReply({ content: `❌ You're not clocked in!` });
      return;
    }

    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - parseUtc(entry.clock_in_time)) / 60000;

    await db.execute({
      sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', warned_at = NULL, stayed_in_at = NULL WHERE id = ?",
      args: [mins, entry.id]
    });
    await db.execute({
      sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?",
      args: [mins / 60, entry.mechanic_id]
    });
    // Clear any in-memory warn/stay state for this shift and remove warning buttons
    warnedMechanics.delete(entry.id);
    stayedIn.delete(entry.mechanic_id);
    await clearWarnMessage(entry, interaction.client);

    const ordersThisShift = await db.execute({
      sql: "SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?",
      args: [interaction.user.id, entry.clock_in_time]
    });
    const orderCount = Number(ordersThisShift.rows[0]?.[0] ?? 0);

    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [entry.id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const clockOutDisplayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const embed = buildClockOutEmbed(
      clockOutDisplayName,
      updated.clock_in_time,
      updated.clock_out_time!,
      mins,
      orderCount
    );

    // Edit original clock-in message in the LOGS channel (not panel channel)
    const CLOCK_LOG_FALLBACK_OUT = "1519941057616412832";
    if (updated.clock_message_id && updated.clock_channel_id && interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(updated.clock_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(updated.clock_message_id);
          await msg.edit({ embeds: [embed] });
        }
      } catch {
        // If original message not found, post new clock-out to clock logs channel
        try {
          if (interaction.guild) {
            const config = await getGuildConfig(interaction.guild.id);
            const logChanId = config?.clocklog_channel_id ?? config?.timeclock_channel_id ?? CLOCK_LOG_FALLBACK_OUT;
            const ch = await interaction.guild.channels.fetch(logChanId);
            if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
          }
        } catch { /* ignore */ }
      }
    } else if (interaction.guild) {
      // No stored clock-in message — post clock-out to log channel directly
      try {
        const config = await getGuildConfig(interaction.guild.id);
        const logChanId = config?.clocklog_channel_id ?? config?.timeclock_channel_id ?? CLOCK_LOG_FALLBACK_OUT;
        const ch = await interaction.guild.channels.fetch(logChanId);
        if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
      } catch { /* ignore */ }
    }

    const hrs = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    await interaction.editReply({ content: `✅ Clocked out! **${hrs}h ${m}m**` });
    return;
  }

  // ── Check Time (how long clocked in) ──────────────────────────────────────
  if (ns === "checktime" && action === "panel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const active = await db.execute({
      sql: "SELECT clock_in_time FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
      args: [interaction.user.id]
    });
    if (!active.rows[0]) {
      await interaction.editReply({ content: "⚫ You're not currently clocked in." });
      return;
    }
    const clockInTime = String(active.rows[0][0]);
    const mins = (Date.now() - new Date(clockInTime).getTime()) / 60000;
    const hrs = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    const unixTs = Math.floor(new Date(clockInTime).getTime() / 1000);
    await interaction.editReply({
      content: `🟢 You've been clocked in for **${hrs}h ${m}m**\n> Started: <t:${unixTs}:t> · <t:${unixTs}:R>`
    });
    return;
  }

  // ── Close Channel (trainer+) ───────────────────────────────────────────────
  if (ns === "closechan" && action === "panel") {
    if (!(await requireRole(interaction, "trainer"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.channel;
    if (!channel || !interaction.guild) {
      await interaction.editReply({ content: "❌ Could not find this channel." });
      return;
    }
    try {
      const chName = (channel as any).name ?? "channel";
      await (channel as any).permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
      try { await (channel as any).setName(`closed-${chName}`.slice(0, 100)); } catch { /* rename may fail if already prefixed */ }
      await (channel as any).send({ content: `🔒 **Channel closed** by <@${interaction.user.id}>` });
      await interaction.editReply({ content: `✅ Channel locked and renamed to \`closed-${chName}\`.` });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to close channel: ${err?.message ?? "Missing permissions"}` });
    }
    return;
  }

  // ── New Week: confirm ─────────────────────────────────────────────────────
  if (ns === "newweek" && action === "confirm") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();

    let sent = 0;
    let failed = 0;
    try {
      const profiles = await db.execute(
        "SELECT discord_id, sales_channel_id FROM profiles WHERE sales_channel_id IS NOT NULL AND sales_channel_id != ''"
      );
      for (const row of profiles.rows) {
        const salesChanId = row[1] ? String(row[1]) : null;
        if (!salesChanId || !interaction.guild) continue;
        try {
          const ch = await interaction.guild.channels.fetch(salesChanId).catch(() => null);
          if (!ch?.isTextBased()) { failed++; continue; }
          await (ch as any).send({
            content:
              "# 🗓️  NEW WEEK — LET'S GET IT!\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "> 💪 **Fresh start. New money. New orders.**\n" +
              "> 🏁 Clock in and get grinding — it's a brand new week at **Tokyo Drift Customs!**\n" +
              "> 📈 Make this week your best one yet.\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          });
          sent++;
        } catch { failed++; }
      }
    } catch { /* ignore */ }

    const embed = new EmbedBuilder()
      .setTitle("📅  NEW WEEK Message Sent")
      .setColor(COLORS.approved)
      .setDescription(
        `✅ Posted to **${sent}** sales channel(s).\n` +
        (failed > 0 ? `⚠️ ${failed} channel(s) skipped (bot may lack access).\n` : "") +
        "\nMechanics will see the NEW WEEK message in their channels."
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  if (ns === "newweek" && action === "cancel") {
    await interaction.update({ content: "❌ Cancelled.", embeds: [], components: [] });
    return;
  }

  // ── Clear: confirm all ────────────────────────────────────────────────────
  if (ns === "clear" && action === "confirm" && rest[0] === "all") {
    await interaction.deferUpdate();
    const callerRole = await detectUserRoleLevel(interaction);
    if (!["manager", "owner"].includes(callerRole)) {
      await interaction.editReply({ content: "❌ Managers only.", components: [] });
      return;
    }
    const guildId = interaction.guildId ?? "";
    // Archive complete orders
    const r = await db.execute({
      sql: "UPDATE orders SET status = 'cleared' WHERE status IN ('complete','approved') AND (guild_id = ? OR guild_id = '')",
      args: [guildId]
    });
    // Delete draft orders entirely
    const drafts = await db.execute({
      sql: "DELETE FROM orders WHERE status = 'draft' AND (guild_id = ? OR guild_id = '')",
      args: [guildId]
    });
    // Full pay-period reset: clear hours, snapshots, AND the manual commission
    // adjustments set via /setpay. Without zeroing commission_adjustment the
    // old fixed amount keeps accumulating on top of all new orders.
    await db.execute("UPDATE profiles SET hours_worked_this_week = 0, commission_adjustment = 0, manager_cut_adjustment = 0, commission_labour_snapshot = 0, manager_labour_snapshot = 0");
    await setSetting("order_number_reset_ts", new Date().toISOString());
    const count = Number(r.rowsAffected ?? 0);
    const draftCount = Number(drafts.rowsAffected ?? 0);
    const embed = new EmbedBuilder()
      .setTitle("🗑️  WEEK CLEARED — ALL CREW")
      .setColor(COLORS.warning)
      .setDescription(
        `Cleared **${count}** completed order(s) and **${draftCount}** draft(s) for all mechanics.\n\n` +
        "**Stats reset:**\n" +
        "• Orders ➜ **0**\n" +
        "• Revenue ➜ **$0**\n" +
        "• Commissions ➜ **$0**\n" +
        "• Hours ➜ **0**\n\n" +
        "*Completed orders are archived. Drafts were deleted. Use `/payall` to pay before clearing next time.*"
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  // ── Clear: confirm player ─────────────────────────────────────────────────
  if (ns === "clear" && action === "confirm" && rest[0] === "player") {
    await interaction.deferUpdate();
    const callerRole = await detectUserRoleLevel(interaction);
    if (!["manager", "owner"].includes(callerRole)) {
      await interaction.editReply({ content: "❌ Managers only.", components: [] });
      return;
    }
    const mechId = rest.slice(1).join(":");
    const guildId = interaction.guildId ?? "";
    const profile = await getProfile(mechId);
    // Archive complete orders
    const r = await db.execute({
      sql: "UPDATE orders SET status = 'cleared' WHERE mechanic_id = ? AND status IN ('complete','approved') AND (guild_id = ? OR guild_id = '')",
      args: [mechId, guildId]
    });
    // Delete draft orders
    const drafts = await db.execute({
      sql: "DELETE FROM orders WHERE mechanic_id = ? AND status = 'draft' AND (guild_id = ? OR guild_id = '')",
      args: [mechId, guildId]
    });
    // Full reset: hours, snapshots, AND manual commission adjustments from /setpay
    await db.execute({ sql: "UPDATE profiles SET hours_worked_this_week = 0, commission_adjustment = 0, manager_cut_adjustment = 0, commission_labour_snapshot = 0, manager_labour_snapshot = 0 WHERE discord_id = ?", args: [mechId] });
    const count = Number(r.rowsAffected ?? 0);
    const draftCount = Number(drafts.rowsAffected ?? 0);
    const embed = new EmbedBuilder()
      .setTitle("🗑️  PLAYER STATS CLEARED")
      .setColor(COLORS.warning)
      .setDescription(
        `Cleared **${count}** order(s) and **${draftCount}** draft(s) for **${profile?.display_name ?? `<@${mechId}>`}**.\n\n` +
        "**Stats reset:**\n" +
        "• Orders ➜ **0**\n" +
        "• Revenue ➜ **$0**\n" +
        "• Commission ➜ **$0**\n" +
        "• Hours ➜ **0**\n\n" +
        "*Other mechanics' stats are unchanged.*"
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  // ── Clear: cancel ─────────────────────────────────────────────────────────
  if (ns === "clear" && action === "cancel") {
    await interaction.update({ content: "❌ Clear cancelled.", embeds: [], components: [] });
    return;
  }

  // ── Order Pay: start (manager+ pay button on order embed) ─────────────────
  if (ns === "orderpay" && action === "start") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const mechId = id;
    const profile = await getProfile(mechId);
    if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }
    const SINCE_RESET = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    const r = await db.execute({
      sql: `SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET}`,
      args: [mechId]
    });
    if (!r.rows.length) {
      await interaction.editReply({ content: `❌ No completed unpaid orders for **${profile.display_name}** this pay period.` });
      return;
    }
    const totalLabour  = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
    const totalRevenue = r.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    // Snapshot-aware commission — matches /setpay, /payall, and draft projections
    const commAdj       = profile.commission_adjustment ?? 0;
    const snapshot      = profile.commission_labour_snapshot ?? 0;
    const labourAfter   = Math.max(0, totalLabour - snapshot);
    const commission    = commAdj > 0
      ? commAdj + labourAfter * profile.commission_rate
      : totalLabour * profile.commission_rate;
    const rateLabel = commAdj > 0
      ? `set ${Math.round(commAdj).toLocaleString()} + new orders`
      : `${(profile.commission_rate * 100).toFixed(0)}%`;
    const confirmEmbed = new EmbedBuilder()
      .setTitle(`💸  Confirm Payout  ·  ${profile.display_name}`)
      .setColor(COLORS.primary)
      .addFields(
        { name: "Orders to Pay",  value: String(r.rows.length), inline: true },
        { name: "Total Revenue",  value: money(totalRevenue),   inline: true },
        { name: "Total Labour",   value: money(totalLabour),    inline: true },
        { name: `Commission (${rateLabel})`, value: `**${money(commission)}**`, inline: false }
      )
      .setDescription("Click **Confirm** to process this payout and mark all orders as paid.")
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`orderpay:confirm:${mechId}`).setLabel("✅ Confirm Payout").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("pay:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [confirmEmbed], components: [row] });
    return;
  }

  // ── Order Pay: confirm (manager+ — separate from /pay which is owner-only) ─
  if (ns === "orderpay" && action === "confirm") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();
    const profile = await getProfile(id);
    if (!profile) { await interaction.followUp({ content: "❌ Mechanic not found.", flags: MessageFlags.Ephemeral }); return; }
    const ws = weekStart();
    const SINCE_RESET_OP = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    const r = await db.execute({
      sql: `SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET_OP}`,
      args: [id]
    });
    if (!r.rows.length) { await interaction.followUp({ content: "❌ No completed orders.", flags: MessageFlags.Ephemeral }); return; }
    const totalLabour = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
    // Snapshot-aware commission
    const commAdj_op    = profile.commission_adjustment ?? 0;
    const snapshot_op   = profile.commission_labour_snapshot ?? 0;
    const labourAfter_op = Math.max(0, totalLabour - snapshot_op);
    const commission = commAdj_op > 0
      ? commAdj_op + labourAfter_op * profile.commission_rate
      : totalLabour * profile.commission_rate;
    const payoutId = randomUUID();
    const weekEnd = new Date(new Date(ws).getTime() + 6 * 86400000).toISOString().split("T")[0];
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, id, ws, commission, r.rows.length, profile.hours_worked_this_week, r.rows.length, interaction.user.id]
    });
    await db.execute({
      sql: `UPDATE orders SET status = 'paid', completed_at = datetime('now') WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET_OP}`,
      args: [id]
    });
    const payR = await db.execute({ sql: "SELECT * FROM payouts WHERE id = ?", args: [payoutId] });
    const payRow = payR.rows[0] as unknown as Record<number, unknown>;
    const payout = {
      id: String(payRow[0]), mechanic_id: String(payRow[1]), week_start: String(payRow[2]),
      amount: Number(payRow[3]), order_count: Number(payRow[4]), hours_worked: Number(payRow[5]),
      invoice_count: Number(payRow[6]), paid_at: String(payRow[7]), paid_by: String(payRow[8]),
      created_at: String(payRow[9] ?? "")
    };
    const approver = await getProfile(interaction.user.id);
    const embed = buildPayoutEmbed(payout, profile.display_name, approver?.display_name ?? "Manager", weekEnd, profile.commission_rate);
    const archiveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:archivepaid:${id}:${ws}`).setLabel("🗃️ Archive Paid Orders").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [archiveRow] });
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.log_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.log_channel_id);
          if (ch?.isTextBased()) await (ch as any).send({ content: `💸 **${profile.display_name}** paid **${money(commission)}** for ${r.rows.length} orders — week of ${ws} (processed by <@${interaction.user.id}>)`, embeds: [embed] });
        } catch { /* ignore */ }
      }
    }
    return;
  }

  // ── Order list pagination ─────────────────────────────────────────────────
  if (ns === "order" && action === "list") {
    await interaction.deferUpdate();
    const page = parseInt(rest[0] ?? "0", 10);
    const status = rest[1] || null;
    const role = await getUserRole(interaction.user.id);
    const isManager = role === "owner" || role === "manager";
    const r = isManager
      ? status
        ? await db.execute({ sql: "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC", args: [status] })
        : await db.execute("SELECT * FROM orders WHERE status != 'draft' ORDER BY created_at DESC")
      : status
        ? await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = ? ORDER BY created_at DESC", args: [interaction.user.id, status] })
        : await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status != 'draft' ORDER BY created_at DESC", args: [interaction.user.id] });

    const rows = r.rows.map(row => rowToOrder(row));
    const { items, total, pages } = paginate(rows, page, 10);
    const lines = await Promise.all(items.map(async o => {
      const p = await getProfile(o.mechanic_id);
      return `${statusEmoji(o.status)} **${o.order_number}** — ${p?.display_name ?? "?"} — ${money(o.total)}`;
    }));
    const embed = new EmbedBuilder()
      .setTitle(`🏁  Orders${status ? ` · ${status.toUpperCase()}` : ""}`)
      .setColor(COLORS.primary)
      .setDescription(lines.join("\n") || "*No orders found*")
      .setFooter({ text: `東京ドリフトカスタム  ·  Page ${page + 1} / ${pages} · ${total} total` })
      .setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:list:${page - 1}:${status ?? ""}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`order:list:${page + 1}:${status ?? ""}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Order archive ─────────────────────────────────────────────────────────
  if (ns === "order" && action === "archive") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Order not found.", flags: MessageFlags.Ephemeral }); return; }
    const order = rowToOrder(r.rows[0]);
    if (!["paid", "complete", "approved"].includes(order.status)) {
      await interaction.followUp({ content: "❌ Only completed or paid orders can be archived.", flags: MessageFlags.Ephemeral });
      return;
    }
    await db.execute({ sql: "UPDATE orders SET status = 'archived' WHERE id = ?", args: [id] });
    const mechanic = await getProfile(order.mechanic_id);
    const archivedOrder = { ...order, status: "archived" as any };
    const embed = buildOrderEmbed(archivedOrder, mechanic?.display_name ?? "Unknown");
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.archive_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.archive_channel_id);
          if (ch?.isTextBased()) await (ch as any).send({ content: `🗃️ Archived by <@${interaction.user.id}>`, embeds: [embed] });
        } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `🗃️ Order **${order.order_number}** archived.`, embeds: [embed], components: [] });
    return;
  }

  // ── Archive paid orders bulk ───────────────────────────────────────────────
  if (ns === "order" && action === "archivepaid") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const mechId = rest[0];
    const ws = rest.slice(1).join(":");
    const r = await db.execute({
      sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = 'paid' AND DATE(created_at) >= ?",
      args: [mechId, ws]
    });
    if (!r.rows.length) { await interaction.followUp({ content: "ℹ️ No paid orders to archive.", flags: MessageFlags.Ephemeral }); return; }
    await db.execute({
      sql: "UPDATE orders SET status = 'archived' WHERE mechanic_id = ? AND status = 'paid' AND DATE(created_at) >= ?",
      args: [mechId, ws]
    });
    const profile = await getProfile(mechId);
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.archive_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.archive_channel_id);
          if (ch?.isTextBased()) {
            for (const row of r.rows) {
              const order = rowToOrder(row);
              const embed = buildOrderEmbed({ ...order, status: "archived" as any }, profile?.display_name ?? "Unknown");
              await (ch as any).send({ embeds: [embed] });
            }
          }
        } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `✅ ${r.rows.length} paid orders archived for **${profile?.display_name ?? "mechanic"}**.`, components: [] });
    return;
  }

  // ── Pay confirm ───────────────────────────────────────────────────────────
  if (ns === "pay" && action === "confirm") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const profile = await getProfile(id);
    if (!profile) { await interaction.followUp({ content: "❌ Mechanic not found.", flags: MessageFlags.Ephemeral }); return; }
    const ws = weekStart();
    const SINCE_RESET_PC = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    const r = await db.execute({
      sql: `SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET_PC}`,
      args: [id]
    });
    if (!r.rows.length) { await interaction.followUp({ content: "❌ No completed orders.", flags: MessageFlags.Ephemeral }); return; }
    const totalLabour = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
    // Snapshot-aware commission — matches /setpay + /payall formula
    const commAdj_pc    = profile.commission_adjustment ?? 0;
    const snapshot_pc   = profile.commission_labour_snapshot ?? 0;
    const labourAfter_pc = Math.max(0, totalLabour - snapshot_pc);
    const commission = commAdj_pc > 0
      ? commAdj_pc + labourAfter_pc * profile.commission_rate
      : totalLabour * profile.commission_rate;
    const payoutId = randomUUID();
    const weekEnd = new Date(new Date(ws).getTime() + 6 * 86400000).toISOString().split("T")[0];
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, id, ws, commission, r.rows.length, profile.hours_worked_this_week, r.rows.length, interaction.user.id]
    });
    await db.execute({
      sql: `UPDATE orders SET status = 'paid', completed_at = datetime('now') WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET_PC}`,
      args: [id]
    });
    const payR = await db.execute({ sql: "SELECT * FROM payouts WHERE id = ?", args: [payoutId] });
    const payRow = payR.rows[0] as unknown as Record<number, unknown>;
    const payout = {
      id: String(payRow[0]), mechanic_id: String(payRow[1]), week_start: String(payRow[2]),
      amount: Number(payRow[3]), order_count: Number(payRow[4]), hours_worked: Number(payRow[5]),
      invoice_count: Number(payRow[6]), paid_at: String(payRow[7]), paid_by: String(payRow[8]),
      created_at: String(payRow[9] ?? "")
    };
    const approver = await getProfile(interaction.user.id);
    const embed = buildPayoutEmbed(payout, profile.display_name, approver?.display_name ?? "Owner", weekEnd, profile.commission_rate);
    const archiveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:archivepaid:${id}:${ws}`).setLabel("🗃️ Archive Paid Orders").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [archiveRow] });
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.log_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.log_channel_id);
          if (ch?.isTextBased()) await (ch as any).send({ content: `💸 **${profile.display_name}** paid **${money(commission)}** for ${r.rows.length} orders — week of ${ws}`, embeds: [embed] });
        } catch { /* ignore */ }
      }
    }
    return;
  }

  if (ns === "pay" && action === "cancel") {
    await interaction.update({ content: "❌ Payout cancelled.", embeds: [], components: [] });
    return;
  }

  // ── Pay All confirm ───────────────────────────────────────────────────────
  if (ns === "payall" && action === "confirm") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();

    const ws = weekStart();
    const result = await processPayall(interaction.guild, ws, interaction.user.id);

    if (!result) {
      await interaction.followUp({ content: "❌ No unpaid orders found to process.", flags: MessageFlags.Ephemeral });
      return;
    }

    const { grandCommission, totalRevenue, mechanicCount, totalToBill, payouts } = result;

    let notified = 0;
    let failed   = 0;

    // ── Notify each mechanic in their personal sales channel ─────────────────
    if (interaction.guild) {
      for (const p of payouts) {
        if (!p.salesChanId) { failed++; continue; }
        try {
          const ch = await interaction.guild.channels.fetch(p.salesChanId).catch(() => null);
          if (!ch?.isTextBased()) { failed++; continue; }

          // Pay notification
          const totalPay = p.amount + p.managerCut;
          await (ch as any).send({
            content:
              `# 💸  PAYDAY — ${p.name.toUpperCase()}!\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `> 📋 **${p.orders} orders** completed this week\n` +
              (p.hours > 0 ? `> ⏱️ **${p.hours.toFixed(1)} hours** worked this week\n` : "") +
              `> 💰 Commission rate: **${(p.rate * 100).toFixed(0)}%**\n` +
              `> 💵 **Your commission this week: ${money(p.amount)}**\n` +
              (p.managerCut > 0 ? `> 👔 **Manager cut: ${money(p.managerCut)}**\n` : "") +
              (p.managerCut > 0 ? `> 🏆 **Total pay: ${money(totalPay)}**\n` : "") +
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `**Bill the company: ${money(totalPay)}** 🏢\n` +
              `Keep grinding, ${p.name}! 🏁`
          });

          // New Week announcement
          await (ch as any).send({
            content: "🗓️ **New pay week — let's get it!** 🏁"
          });

          // Re-post the order panel so they can start fresh
          const profile2 = await getProfile(p.mechanicId);
          await postOrderPanel(ch as any, p.mechanicId, profile2?.display_name ?? p.name, profile2?.commission_rate ?? p.rate);

          notified++;
        } catch { failed++; }
      }
    }

    // ── Post payroll log to pay-logs channel ──────────────────────────────────
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      const payLogsChanId = config?.payday_channel_id;
      if (payLogsChanId) {
        try {
          const ch = await interaction.guild.channels.fetch(payLogsChanId);
          if (ch?.isTextBased()) {
            const payLines = payouts.map(p => {
              const hrsNote = p.hours > 0 ? ` · ${p.hours.toFixed(1)}h` : "";
              return `**${p.name}** · ${p.orders} orders${hrsNote} · ${(p.rate * 100).toFixed(0)}% → **${money(p.amount)}**`;
            });
            const logEmbed = new EmbedBuilder()
              .setTitle("💸  PAYROLL PROCESSED — New Week Started")
              .setColor(0xffd700)
              .setDescription(
                `**Pay period:** Week of \`${ws}\`\n` +
                `**Total revenue:** ${money(totalRevenue)}\n\n` +
                `✅ Pay messages sent to **${notified}** mechanic(s).` +
                (failed > 0 ? `\n⚠️ ${failed} skipped (no sales channel).` : "")
              )
              .addFields(
                { name: `🔩 Crew Paid (${mechanicCount})`,       value: payLines.join("\n") || "None", inline: false },
                { name: "💰 Total Commission Out",                value: money(grandCommission),        inline: true  },
                { name: "🏢 Total Billed to Company",            value: `**${money(totalToBill)}**`,   inline: true  }
              )
              .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
              .setTimestamp();
            await (ch as any).send({ embeds: [logEmbed] });
          }
        } catch { /* ignore */ }
      }
    }

    const summaryEmbed = new EmbedBuilder()
      .setTitle("✅  PAYROLL PROCESSED")
      .setColor(COLORS.paid)
      .setDescription(
        `**${mechanicCount}** crew members paid for week of \`${ws}\`\n` +
        `Total billed to company: **${money(totalToBill)}**\n\n` +
        "• All completed orders marked as **paid**\n" +
        "• Weekly stats reset to **zero**\n" +
        "• Order numbers reset to **TDC-0001**\n" +
        `• Pay messages sent to **${notified}** sales channels ✅\n` +
        "• Each mechanic's sales channel has their new order panel ✅"
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
      .setTimestamp();

    await interaction.editReply({ embeds: [summaryEmbed], components: [] });
    return;
  }

  if (ns === "payall" && action === "cancel") {
    await interaction.update({ content: "❌ Payall cancelled.", embeds: [], components: [] });
    return;
  }

  // ── Schedule Payday now ────────────────────────────────────────────────────
  if (ns === "payall" && action === "schedulenow") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ws = weekStart();
    const embed = await buildPayallSummaryEmbed(ws, interaction.guild ?? undefined);
    if (!embed) {
      await interaction.editReply({ content: "❌ No unpaid completed orders this week." });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("payall:confirm").setLabel("✅ Process All Payouts + Announce Payday").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("payall:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Sales view detailed ───────────────────────────────────────────────────
  if (ns === "sales" && action === "viewdetailed") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const profile = await getProfile(id);
    if (!profile) { await interaction.editReply({ content: "❌ Profile not found." }); return; }
    const ws = weekStart();
    const today = new Date().toISOString().split("T")[0];
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const SINCE_RESET_VD = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    const weekR   = await db.execute({ sql: `SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND ${SINCE_RESET_VD}`, args: [id] });
    const todayR  = await db.execute({ sql: "SELECT total FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) = ?",              args: [id, today] });
    const ytdR    = await db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?",    args: [id, yearStart] });
    const weekRev   = weekR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const weekLabour = weekR.rows.reduce((s, row) => s + Number(row[1] ?? 0), 0);
    const todayRev  = todayR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdRev    = ytdR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdCommission = ytdR.rows.reduce((s, row) => s + Number(row[1] ?? 0) * profile.commission_rate, 0);
    // Snapshot-aware week commission — matches /setpay + draft projections
    const commAdj_vd    = profile.commission_adjustment ?? 0;
    const snapshot_vd   = profile.commission_labour_snapshot ?? 0;
    const labourAfter_vd = Math.max(0, weekLabour - snapshot_vd);
    const weekCommission = commAdj_vd > 0
      ? commAdj_vd + labourAfter_vd * profile.commission_rate
      : weekLabour * profile.commission_rate;
    const embed = buildDashboardEmbed(profile.display_name, profile.status, todayR.rows.length, todayRev, weekR.rows.length, weekRev, profile.hours_worked_this_week, weekCommission, ytdR.rows.length, ytdRev, ytdCommission);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Job delete ─────────────────────────────────────────────────────────────
  if (ns === "job" && action === "delete") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT title, discord_message_id FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Job not found.", flags: MessageFlags.Ephemeral }); return; }
    const [title, msgId] = [String(r.rows[0][0]), String(r.rows[0][1] ?? "")];
    await db.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [id] });
    if (msgId && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.jobs_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.jobs_channel_id);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).messages.fetch(msgId);
            await msg.delete();
          }
        } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `✅ Job **${title}** deleted.`, embeds: [], components: [] });
    return;
  }

  // ── Job apply ──────────────────────────────────────────────────────────────
  if (ns === "job" && action === "apply") {
    const r = await db.execute({ sql: "SELECT title FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.reply({ content: "❌ This job posting no longer exists.", flags: MessageFlags.Ephemeral }); return; }
    const title = String(r.rows[0][0]);
    const modal = new ModalBuilder().setCustomId(`job:applymodal:${id}`).setTitle(`Apply — ${title.slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("message").setLabel("Why do you want this position?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("experience").setLabel("Relevant experience (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── Manager force clock-out button (from /timeclock who-is-in) ────────────
  if (ns === "tcmgr" && action === "forceout") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetId = id;

    const activeR = await db.execute({
      sql: `SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1`,
      args: [targetId]
    });

    if (!activeR.rows[0]) {
      await interaction.editReply({ content: `❌ <@${targetId}> is not currently clocked in.` });
      return;
    }

    const entry = rowToTimeclock(activeR.rows[0]);
    const mins  = (Date.now() - parseUtc(entry.clock_in_time)) / 60000;
    const reason = `Clocked out by manager via panel`;

    await db.execute({
      sql: `UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', warned_at = NULL, notes = ? WHERE id = ?`,
      args: [mins, reason, entry.id]
    });
    await db.execute({
      sql: `UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?`,
      args: [mins / 60, targetId]
    });

    warnedMechanics.delete(entry.id);
    stayedIn.delete(targetId);
    await clearWarnMessage(entry, interaction.client);

    const profile = await getProfile(targetId);
    const name    = profile?.display_name ?? `<@${targetId}>`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);

    // Edit clock-in message in the timeclock channel if we have it
    const clockEmbed = buildClockOutEmbed(name, entry.clock_in_time, new Date().toISOString().replace("T", " ").slice(0, 19), mins, 0);
    if (entry.clock_message_id && entry.clock_channel_id && interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(entry.clock_channel_id).catch(() => null);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(entry.clock_message_id).catch(() => null);
          if (msg) await msg.edit({ embeds: [clockEmbed] });
        }
      } catch { /* ignore */ }
    }

    // Rebuild the who-is-in panel with the remaining active mechanics (if any)
    try {
      const remainingR = await db.execute(
        `SELECT id, mechanic_id, clock_in_time FROM timeclock WHERE clock_out_time IS NULL ORDER BY clock_in_time ASC`
      );
      if (!remainingR.rows.length) {
        await interaction.message.edit({ content: "✅ Nobody is currently clocked in.", embeds: [], components: [] });
      } else {
        const entries = await Promise.all(remainingR.rows.map(async row => {
          const mechanicId = String(row[1] ?? "");
          const clockIn    = String(row[2] ?? "");
          const p          = await getProfile(mechanicId);
          const name       = p?.display_name ?? mechanicId;
          const mins       = Math.round((Date.now() - new Date(clockIn).getTime()) / 60000);
          const h = Math.floor(mins / 60);
          const m = mins % 60;
          const unixTs = Math.floor(new Date(clockIn).getTime() / 1000);
          return { mechanicId, name, h, m, unixTs };
        }));
        const lines = entries.map(e =>
          `• **${e.name}** — <@${e.mechanicId}> — ${e.h}h ${e.m}m  ·  <t:${e.unixTs}:R>`
        );
        const updatedEmbed = new EmbedBuilder()
          .setTitle(`⏰  Currently Clocked In (${entries.length})`)
          .setColor(COLORS.primary)
          .setDescription(lines.join("\n"))
          .setFooter({ text: "Tokyo Drift Customs  ·  Click a button below to clock someone out" })
          .setTimestamp();
        const updatedRows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < Math.min(entries.length, 5); i++) {
          const e = entries[i];
          if (i % 5 === 0) updatedRows.push(new ActionRowBuilder<ButtonBuilder>());
          updatedRows[updatedRows.length - 1].addComponents(
            new ButtonBuilder()
              .setCustomId(`tcmgr:forceout:${e.mechanicId}`)
              .setLabel(`🔴 Clock Out ${e.name.slice(0, 15)}`)
              .setStyle(ButtonStyle.Danger)
          );
        }
        await interaction.message.edit({ embeds: [updatedEmbed], components: updatedRows });
      }
    } catch { /* ignore */ }

    await interaction.editReply({
      content: `✅ **${name}** has been clocked out. Shift: **${h}h ${m}m**`
    });
    return;
  }

  // ── Settings catalog ───────────────────────────────────────────────────────
  if (ns === "settings" && action === "viewcatalog") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const catalog = JSON.parse((await getSetting("parts_catalog")) ?? "{}");
    const items: any[] = catalog.items ?? [];
    const grouped: Record<string, string[]> = {};
    for (const item of items) {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(`${item.label} — Parts: ${money(item.cost)} | Labour: ${money(item.labour)} | Total: ${money(item.price)}`);
    }
    const embed = new EmbedBuilder()
      .setTitle("📋  Parts & Services Catalog")
      .setColor(COLORS.dark)
      .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
      .setTimestamp();
    for (const [cat, list] of Object.entries(grouped)) {
      embed.addFields({ name: cat, value: list.join("\n").slice(0, 1024) });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
