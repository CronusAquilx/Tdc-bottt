import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { db, getProfile, getGuildConfig, getUserRole, rowToOrder, rowToTimeclock } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, buildClockInEmbed, buildClockOutEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID, weekStart, paginate } from "../lib/utils.js";
import { warnedMechanics, stayedIn } from "../lib/warnState.js";
import { autoClockOut } from "../lib/autoClockOut.js";
import { processPayall, buildPayallSummaryEmbed } from "../commands/payall.js";

export async function handleButton(interaction: ButtonInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const id = rest.join(":");

  // ── Clock-warning: Stay Clocked In ────────────────────────────────────────
  if (ns === "clockwarn" && action === "stayin") {
    await interaction.deferReply({ ephemeral: true });
    const tcId = id;
    const warnInfo = warnedMechanics.get(tcId);
    if (!warnInfo) {
      await interaction.editReply({ content: "ℹ️ No active warning found — you're good!" });
      return;
    }
    // Check it's the right user
    if (warnInfo.mechanicId !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This warning isn't for you." });
      return;
    }
    warnedMechanics.delete(tcId);
    stayedIn.set(interaction.user.id, Date.now());
    // Disable the warning message buttons
    try {
      if (warnInfo.msgId && warnInfo.chanId && interaction.guild) {
        const ch = await interaction.guild.channels.fetch(warnInfo.chanId);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(warnInfo.msgId).catch(() => null);
          if (msg) await msg.edit({ content: `✅ <@${interaction.user.id}> stayed clocked in.`, components: [] });
        }
      }
    } catch { /* ignore */ }
    await interaction.editReply({ content: "✅ Got it — you're still clocked in! Keep up the good work." });
    return;
  }

  // ── Clock-warning: Clock Out Now ──────────────────────────────────────────
  if (ns === "clockwarn" && action === "clockout") {
    await interaction.deferReply({ ephemeral: true });
    const tcId = id;
    const warnInfo = warnedMechanics.get(tcId);

    // Find the timeclock entry
    const tcR = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
    if (!tcR.rows[0]) { await interaction.editReply({ content: "❌ Timeclock entry not found." }); return; }
    const entry = rowToTimeclock(tcR.rows[0]);

    if (entry.clock_out_time) { await interaction.editReply({ content: "ℹ️ Already clocked out." }); return; }
    if (entry.mechanic_id !== interaction.user.id) {
      await interaction.editReply({ content: "❌ This isn't your timeclock entry." }); return;
    }

    warnedMechanics.delete(tcId);

    // Disable warning message
    try {
      if (warnInfo?.msgId && warnInfo?.chanId && interaction.guild) {
        const ch = await interaction.guild.channels.fetch(warnInfo.chanId);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(warnInfo.msgId).catch(() => null);
          if (msg) await msg.edit({ content: `🔴 <@${interaction.user.id}> clocked out.`, components: [] });
        }
      }
    } catch { /* ignore */ }

    await autoClockOut(
      interaction.client,
      interaction.guild,
      tcId,
      entry.mechanic_id,
      entry.clock_in_time,
      entry.clock_message_id ?? null,
      entry.clock_channel_id ?? null
    );

    const mins = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;
    const hrs = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    await interaction.editReply({ content: `✅ Clocked out! **${hrs}h ${m}m**` });
    return;
  }

  // ── Clock In from panel ────────────────────────────────────────────────────
  if (ns === "clockin" && action === "panel") {
    await interaction.deferReply({ ephemeral: true });

    const active = await db.execute({
      sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
      args: [interaction.user.id]
    });
    if (active.rows[0]) {
      await interaction.editReply({ content: `⚠️ <@${interaction.user.id}> You're already clocked in! Hit **Clock Out** first.` });
      return;
    }

    const tcId = randomUUID();
    await db.execute({
      sql: "INSERT INTO timeclock (id, mechanic_id, clock_in_time) VALUES (?, ?, datetime('now'))",
      args: [tcId, interaction.user.id]
    });
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
    const entry = rowToTimeclock(r.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const displayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const embed = buildClockInEmbed(displayName, entry.clock_in_time);

    // Always post to the configured timeclock channel
    let posted = false;
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.timeclock_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.timeclock_channel_id);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({ embeds: [embed] });
            await db.execute({
              sql: "UPDATE timeclock SET clock_message_id = ?, clock_channel_id = ? WHERE id = ?",
              args: [msg.id, ch.id, tcId]
            });
            posted = true;
          }
        } catch { /* ignore */ }
      }
    }

    await interaction.editReply({ content: posted ? "✅ Clocked in!" : "✅ Clocked in! (no timeclock channel configured)", ephemeral: true } as any);
    return;
  }

  // ── Clock Out from panel ───────────────────────────────────────────────────
  if (ns === "clockout" && action === "panel") {
    await interaction.deferReply({ ephemeral: true });

    const active = await db.execute({
      sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1",
      args: [interaction.user.id]
    });
    if (!active.rows[0]) {
      await interaction.editReply({ content: `❌ You're not clocked in!` });
      return;
    }

    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;

    await db.execute({
      sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved' WHERE id = ?",
      args: [mins, entry.id]
    });
    await db.execute({
      sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ? WHERE discord_id = ?",
      args: [mins / 60, entry.mechanic_id]
    });

    const ordersThisShift = await db.execute({
      sql: "SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status != 'draft' AND created_at >= ?",
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

    // Edit the original clock-in message in the timeclock channel
    if (updated.clock_message_id && updated.clock_channel_id && interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(updated.clock_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(updated.clock_message_id);
          await msg.edit({ embeds: [embed] });
        }
      } catch {
        // If original message not found, post a new clock-out to the timeclock channel
        try {
          const config = await getGuildConfig(interaction.guild.id);
          if (config?.timeclock_channel_id) {
            const ch = await interaction.guild.channels.fetch(config.timeclock_channel_id);
            if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
          }
        } catch { /* ignore */ }
      }
    }

    const hrs = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    await interaction.editReply({ content: `✅ Clocked out! **${hrs}h ${m}m**` });
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
    const { statusEmoji } = await import("../lib/embeds.js");
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
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Order not found.", ephemeral: true }); return; }
    const order = rowToOrder(r.rows[0]);
    if (!["paid", "complete", "approved"].includes(order.status)) {
      await interaction.followUp({ content: "❌ Only completed or paid orders can be archived.", ephemeral: true });
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
    if (!r.rows.length) { await interaction.followUp({ content: "ℹ️ No paid orders to archive.", ephemeral: true }); return; }
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
    if (!profile) { await interaction.followUp({ content: "❌ Mechanic not found.", ephemeral: true }); return; }
    const ws = weekStart();
    const r = await db.execute({
      sql: "SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?",
      args: [id, ws]
    });
    if (!r.rows.length) { await interaction.followUp({ content: "❌ No completed orders.", ephemeral: true }); return; }
    const totalLabour = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
    const commission = totalLabour * profile.commission_rate;
    const payoutId = randomUUID();
    const weekEnd = new Date(new Date(ws).getTime() + 6 * 86400000).toISOString().split("T")[0];
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, id, ws, commission, r.rows.length, profile.hours_worked_this_week, r.rows.length, interaction.user.id]
    });
    await db.execute({
      sql: "UPDATE orders SET status = 'paid', completed_at = datetime('now') WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?",
      args: [id, ws]
    });
    const payR = await db.execute({ sql: "SELECT * FROM payouts WHERE id = ?", args: [payoutId] });
    const payRow = payR.rows[0] as unknown as Record<number, unknown>;
    const payout = {
      id: String(payRow[0]), mechanic_id: String(payRow[1]), week_start: String(payRow[2]),
      amount: Number(payRow[3]), order_count: Number(payRow[4]), hours_worked: Number(payRow[5]),
      invoice_count: Number(payRow[6]), paid_at: String(payRow[7]), paid_by: String(payRow[8]),
      created_at: String(payRow[9] ?? "")
    };
    const { buildPayoutEmbed } = await import("../lib/embeds.js");
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
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();

    const ws = weekStart();
    const result = await processPayall(interaction.guild, ws, interaction.user.id);

    if (!result) {
      await interaction.followUp({ content: "❌ No unpaid orders found to process.", ephemeral: true });
      return;
    }

    const { grandCommission, totalRevenue, mechanicCount, totalToBill } = result;

    // Post big payday announcement
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      const announceChanId = config?.payday_channel_id ?? config?.log_channel_id ?? config?.orders_channel_id;
      if (announceChanId) {
        try {
          const ch = await interaction.guild.channels.fetch(announceChanId);
          if (ch?.isTextBased()) {
            const paydayEmbed = new EmbedBuilder()
              .setTitle("💸  IT'S PAYDAY! — NEW WEEK STARTS NOW")
              .setColor(0xffd700)
              .setDescription(
                "# 🎉  PAYDAY IS HERE!\n\n" +
                "All crew have been paid for this week's work.\n" +
                "**Order numbers have been reset — fresh start for everyone!**\n\n" +
                "> 💪 Keep grinding. New week, new money.\n" +
                "> 📅 **Payday is every Monday** — stay clocked in, stay stacking."
              )
              .addFields(
                { name: "👥 Crew Paid",           value: String(mechanicCount),    inline: true },
                { name: "💵 Total Revenue",        value: money(totalRevenue),      inline: true },
                { name: "💰 Total Commissions Out",value: money(grandCommission),   inline: true },
                { name: "🏢 Total Billed to Company", value: `**${money(totalToBill)}**`, inline: false }
              )
              .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
              .setTimestamp();

            await (ch as any).send({
              content: "@everyone",
              embeds: [paydayEmbed]
            });
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
        "• Payday announcement posted ✅"
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
    await interaction.deferReply({ ephemeral: true });
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
    await interaction.deferReply({ ephemeral: true });
    const profile = await getProfile(id);
    if (!profile) { await interaction.editReply({ content: "❌ Profile not found." }); return; }
    const ws = weekStart();
    const today = new Date().toISOString().split("T")[0];
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const weekR   = await db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?",    args: [id, ws] });
    const todayR  = await db.execute({ sql: "SELECT total FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) = ?",              args: [id, today] });
    const ytdR    = await db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?",    args: [id, yearStart] });
    const weekRev = weekR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const weekCommission = weekR.rows.reduce((s, row) => s + Number(row[1] ?? 0) * profile.commission_rate, 0);
    const todayRev = todayR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdRev   = ytdR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdCommission = ytdR.rows.reduce((s, row) => s + Number(row[1] ?? 0) * profile.commission_rate, 0);
    const { buildDashboardEmbed } = await import("../lib/embeds.js");
    const embed = buildDashboardEmbed(profile.display_name, profile.status, todayR.rows.length, todayRev, weekR.rows.length, weekRev, profile.hours_worked_this_week, weekCommission, ytdR.rows.length, ytdRev, ytdCommission);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Job delete ─────────────────────────────────────────────────────────────
  if (ns === "job" && action === "delete") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT title, discord_message_id FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Job not found.", ephemeral: true }); return; }
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
    if (!r.rows[0]) { await interaction.reply({ content: "❌ This job posting no longer exists.", ephemeral: true }); return; }
    const title = String(r.rows[0][0]);
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = await import("discord.js");
    const modal = new ModalBuilder().setCustomId(`job:applymodal:${id}`).setTitle(`Apply — ${title.slice(0, 40)}`);
    modal.addComponents(
      new AR<InstanceType<typeof TextInputBuilder>>().addComponents(
        new TextInputBuilder().setCustomId("message").setLabel("Why do you want this position?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
      ),
      new AR<InstanceType<typeof TextInputBuilder>>().addComponents(
        new TextInputBuilder().setCustomId("experience").setLabel("Relevant experience (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── Settings catalog ───────────────────────────────────────────────────────
  if (ns === "settings" && action === "viewcatalog") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const { getSetting } = await import("../db.js");
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
