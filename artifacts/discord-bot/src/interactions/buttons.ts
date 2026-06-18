import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { db, getProfile, getGuildConfig, getUserRole, rowToOrder, rowToTimeclock } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, buildTimeclockEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID, weekStart, paginate } from "../lib/utils.js";
import type { Order } from "../types.js";

export async function handleButton(interaction: ButtonInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const id = rest.join(":");

  // ── Order approve/reject ───────────────────────────────
  if (ns === "order" && action === "approve") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Order not found.", ephemeral: true }); return; }
    const order = rowToOrder(r.rows[0]);
    if (order.status !== "submitted") { await interaction.followUp({ content: "❌ Order cannot be approved.", ephemeral: true }); return; }
    await db.execute({ sql: "UPDATE orders SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?", args: [interaction.user.id, id] });
    const ur = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
    const updated = rowToOrder(ur.rows[0]);
    const [mechanic, approver] = await Promise.all([getProfile(order.mechanic_id), getProfile(interaction.user.id)]);
    const commRate = mechanic?.commission_rate ?? 0.4;
    const embed = buildOrderEmbed(updated, mechanic?.display_name ?? "Unknown", approver?.display_name, commRate);
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  if (ns === "order" && action === "rejectprompt") {
    if (!(await requireRole(interaction, "manager"))) return;
    const modal = new ModalBuilder().setCustomId(`order:rejectmodal:${id}`).setTitle("Reject Order — Reason");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Rejection Reason").setStyle(TextInputStyle.Paragraph).setRequired(true)
    ));
    await interaction.showModal(modal);
    return;
  }

  if (ns === "order" && action === "list") {
    await interaction.deferUpdate();
    const page = parseInt(rest[0] ?? "0", 10);
    const status = rest[1] || null;
    const role = await getUserRole(interaction.user.id);
    const isManager = role === "owner" || role === "manager";
    const r = isManager
      ? status ? await db.execute({ sql: "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC", args: [status] }) : await db.execute("SELECT * FROM orders ORDER BY created_at DESC")
      : status ? await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = ? ORDER BY created_at DESC", args: [interaction.user.id, status] }) : await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? ORDER BY created_at DESC", args: [interaction.user.id] });
    const rows = r.rows.map(row => rowToOrder(row));
    const { statusEmoji } = await import("../lib/embeds.js");
    const { items, total, pages } = paginate(rows, page, 10);
    const lines = await Promise.all(items.map(async o => {
      const p = await getProfile(o.mechanic_id);
      return `${statusEmoji(o.status)} **${o.order_number}** — ${p?.display_name ?? "?"} — ${money(o.total)} — \`${o.status.toUpperCase()}\``;
    }));
    const embed = new EmbedBuilder()
      .setTitle(`📋 Orders${status ? ` · ${status.toUpperCase()}` : ""}`)
      .setColor(COLORS.primary).setDescription(lines.join("\n") || "_No orders_")
      .setFooter({ text: `Tokyo Drift Customs | Page ${page + 1} / ${pages} · ${total} total` }).setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:list:${page - 1}:${status ?? ""}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`order:list:${page + 1}:${status ?? ""}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Order archive ──────────────────────────────────────
  if (ns === "order" && action === "archive") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Order not found.", ephemeral: true }); return; }
    const order = rowToOrder(r.rows[0]);
    if (!["paid", "rejected"].includes(order.status)) { await interaction.followUp({ content: "❌ Only paid or rejected orders can be archived.", ephemeral: true }); return; }
    await db.execute({ sql: "UPDATE orders SET status = 'archived' WHERE id = ?", args: [id] });
    const mechanic = await getProfile(order.mechanic_id);
    const commRate = mechanic?.commission_rate ?? 0.4;
    const archivedOrder = { ...order, status: "archived" as any };
    const embed = buildOrderEmbed(archivedOrder, mechanic?.display_name ?? "Unknown", undefined, commRate);
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

  // ── Timeclock approve/reject ───────────────────────────
  if (ns === "timeclock" && (action === "approve" || action === "reject")) {
    if (!(await requireRole(interaction, "trainer"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Entry not found.", ephemeral: true }); return; }
    const entry = rowToTimeclock(r.rows[0]);
    if (action === "approve") {
      await db.execute({ sql: "UPDATE timeclock SET status = 'approved', approved_by = ? WHERE id = ?", args: [interaction.user.id, id] });
      await db.execute({ sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ? WHERE discord_id = ?", args: [entry.duration_minutes / 60, entry.mechanic_id] });
    } else {
      await db.execute({ sql: "UPDATE timeclock SET status = 'rejected' WHERE id = ?", args: [id] });
    }
    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const profile = await getProfile(entry.mechanic_id);
    const embed = buildTimeclockEmbed(profile?.display_name ?? "Unknown", updated.clock_in_time, updated.clock_out_time, updated.duration_minutes, updated.status, updated.notes);
    await interaction.editReply({ embeds: [embed], components: [] });
    return;
  }

  // ── Clock In/Out from sales channel ───────────────────
  if (ns === "clockin" && action === "mechanic") {
    if (interaction.user.id !== id) { await interaction.reply({ content: "❌ You can only clock in for yourself.", ephemeral: true }); return; }
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const active = await db.execute({ sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1", args: [id] });
    if (active.rows[0]) { await interaction.editReply({ content: "⚠️ You're already clocked in." }); return; }
    const tcId = randomUUID();
    await db.execute({ sql: "INSERT INTO timeclock (id, mechanic_id, clock_in_time) VALUES (?, ?, datetime('now'))", args: [tcId, id] });
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [tcId] });
    const { buildTimeclockEmbed } = await import("../lib/embeds.js");
    const entry = rowToTimeclock(r.rows[0]);
    const profile = await getProfile(id);
    const embed = buildTimeclockEmbed(profile?.display_name ?? "Unknown", entry.clock_in_time, null, 0, "pending", null);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (ns === "clockout" && action === "mechanic") {
    if (interaction.user.id !== id) { await interaction.reply({ content: "❌ You can only clock out for yourself.", ephemeral: true }); return; }
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const active = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1", args: [id] });
    if (!active.rows[0]) { await interaction.editReply({ content: "❌ You're not clocked in." }); return; }
    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;
    await db.execute({ sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'pending' WHERE id = ?", args: [mins, entry.id] });
    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [entry.id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const profile = await getProfile(id);
    const { buildTimeclockEmbed } = await import("../lib/embeds.js");
    const embed = buildTimeclockEmbed(profile?.display_name ?? "Unknown", updated.clock_in_time, updated.clock_out_time, mins, "pending", null);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`timeclock:approve:${entry.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`timeclock:reject:${entry.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Pay confirm ────────────────────────────────────────
  if (ns === "pay" && action === "confirm") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const profile = await getProfile(id);
    if (!profile) { await interaction.followUp({ content: "❌ Mechanic not found.", ephemeral: true }); return; }
    const ws = weekStart();
    const r = await db.execute({ sql: "SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status = 'approved' AND DATE(created_at) >= ?", args: [id, ws] });
    if (!r.rows.length) { await interaction.followUp({ content: "❌ No approved orders.", ephemeral: true }); return; }
    const totalLabour = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
    const commission = totalLabour * profile.commission_rate;
    const payoutId = randomUUID();
    const weekEnd = new Date(new Date(ws).getTime() + 6 * 86400000).toISOString().split("T")[0];
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, id, ws, commission, r.rows.length, profile.hours_worked_this_week, r.rows.length, interaction.user.id]
    });
    await db.execute({ sql: "UPDATE orders SET status = 'paid', completed_at = datetime('now') WHERE mechanic_id = ? AND status = 'approved' AND DATE(created_at) >= ?", args: [id, ws] });
    const payR = await db.execute({ sql: "SELECT * FROM payouts WHERE id = ?", args: [payoutId] });
    const payRow = payR.rows[0] as unknown as Record<number, unknown>;
    const payout = { id: String(payRow[0]), mechanic_id: String(payRow[1]), week_start: String(payRow[2]), amount: Number(payRow[3]), order_count: Number(payRow[4]), hours_worked: Number(payRow[5]), invoice_count: Number(payRow[6]), paid_at: String(payRow[7]), paid_by: String(payRow[8]), created_at: String(payRow[9] ?? "") };
    const { buildPayoutEmbed } = await import("../lib/embeds.js");
    const approver = await getProfile(interaction.user.id);
    const embed = buildPayoutEmbed(payout, profile.display_name, approver?.display_name ?? "Owner", weekEnd, profile.commission_rate);
    const archiveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:archivepaid:${id}:${ws}`).setLabel("🗃️ Archive All Paid Orders").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [archiveRow] });
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.log_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.log_channel_id);
          if (ch?.isTextBased()) await (ch as any).send({ content: `${profile.display_name} paid ${money(commission)} for ${r.rows.length} orders, ${profile.hours_worked_this_week.toFixed(1)} hours, week of ${ws}`, embeds: [embed] });
        } catch { /* ignore */ }
      }
    }
    return;
  }

  if (ns === "pay" && action === "cancel") {
    await interaction.update({ content: "❌ Payout cancelled.", embeds: [], components: [] });
    return;
  }

  // ── Archive all paid orders for mechanic ──────────────
  if (ns === "order" && action === "archivepaid") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const mechId = rest[0];
    const ws = rest.slice(1).join(":");
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = 'paid' AND DATE(created_at) >= ?", args: [mechId, ws] });
    if (!r.rows.length) { await interaction.followUp({ content: "ℹ️ No paid orders to archive.", ephemeral: true }); return; }
    await db.execute({ sql: "UPDATE orders SET status = 'archived' WHERE mechanic_id = ? AND status = 'paid' AND DATE(created_at) >= ?", args: [mechId, ws] });
    const profile = await getProfile(mechId);
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.archive_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.archive_channel_id);
          if (ch?.isTextBased()) {
            const commRate = profile?.commission_rate ?? 0.4;
            for (const row of r.rows) {
              const order = rowToOrder(row);
              const embed = buildOrderEmbed({ ...order, status: "archived" as any }, profile?.display_name ?? "Unknown", undefined, commRate);
              await (ch as any).send({ embeds: [embed] });
            }
          }
        } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `✅ ${r.rows.length} paid orders archived for **${profile?.display_name ?? "mechanic"}**.`, components: [] });
    return;
  }

  // ── Breakdown expand ───────────────────────────────────
  if (ns === "breakdown" && action === "expand") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });
    const profile = await getProfile(id);
    if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? ORDER BY created_at DESC LIMIT 10", args: [id] });
    if (!r.rows.length) { await interaction.editReply({ content: `No orders for **${profile.display_name}**.` }); return; }
    const { statusEmoji } = await import("../lib/embeds.js");
    const lines = r.rows.map(row => {
      const o = rowToOrder(row);
      const cats = [...new Set(o.items.map((i: any) => i.category))].join(", ");
      return `${statusEmoji(o.status)} **${o.order_number}** — ${money(o.total)} — ${cats || "No items"} — \`${o.status.toUpperCase()}\``;
    });
    const embed = new EmbedBuilder()
      .setTitle(`📋 Orders · ${profile.display_name}`).setColor(COLORS.primary)
      .setDescription(lines.join("\n")).setFooter({ text: "Tokyo Drift Customs | Last 10 orders" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Sales view detailed ────────────────────────────────
  if (ns === "sales" && action === "viewdetailed") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const profile = await getProfile(id);
    if (!profile) { await interaction.editReply({ content: "❌ Profile not found." }); return; }
    const ws = weekStart();
    const today = new Date().toISOString().split("T")[0];
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const weekR = await db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid') AND DATE(created_at) >= ?", args: [id, ws] });
    const todayR = await db.execute({ sql: "SELECT total FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid') AND DATE(created_at) = ?", args: [id, today] });
    const ytdR = await db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid') AND DATE(created_at) >= ?", args: [id, yearStart] });

    const weekRev = weekR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const weekCommission = weekR.rows.reduce((s, row) => s + Number(row[1] ?? 0) * profile.commission_rate, 0);
    const todayRev = todayR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdRev = ytdR.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
    const ytdCommission = ytdR.rows.reduce((s, row) => s + Number(row[1] ?? 0) * profile.commission_rate, 0);

    const { buildDashboardEmbed } = await import("../lib/embeds.js");
    const embed = buildDashboardEmbed(
      profile.display_name, profile.status,
      todayR.rows.length, todayRev,
      weekR.rows.length, weekRev,
      profile.hours_worked_this_week, weekCommission,
      ytdR.rows.length, ytdRev, ytdCommission
    );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Job delete ─────────────────────────────────────────
  if (ns === "job" && action === "delete") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT title, discord_message_id FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.followUp({ content: "❌ Job not found.", ephemeral: true }); return; }
    const [title, msgId] = [String(r.rows[0][0]), String(r.rows[0][1] ?? "")];
    await db.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [id] });
    if (msgId && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.jobs_channel_id) { try { const ch = await interaction.guild.channels.fetch(config.jobs_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).messages.fetch(msgId); await msg.delete(); } } catch { /* ignore */ } }
    }
    await interaction.editReply({ content: `✅ Job **${title}** deleted.`, embeds: [], components: [] });
    return;
  }

  // ── Job apply ──────────────────────────────────────────
  if (ns === "job" && action === "apply") {
    const r = await db.execute({ sql: "SELECT title FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.reply({ content: "❌ This job posting no longer exists.", ephemeral: true }); return; }
    const title = String(r.rows[0][0]);
    const modal = new ModalBuilder()
      .setCustomId(`job:applymodal:${id}`)
      .setTitle(`Apply — ${title.slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("Why do you want this position?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
          .setPlaceholder("Tell us about yourself and why you'd be a great fit...")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("experience")
          .setLabel("Relevant experience (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder("e.g. 2 years of mechanic work, GTA RP experience...")
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── Settings catalog ───────────────────────────────────
  if (ns === "settings" && action === "viewcatalog") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ ephemeral: true });
    const { getSetting } = await import("../db.js");
    const catalog = JSON.parse((await getSetting("parts_catalog")) ?? "{}");
    const items: any[] = catalog.items ?? [];
    const grouped: Record<string, string[]> = {};
    for (const item of items) {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(`${item.label} — ${money(item.price)}`);
    }
    const embed = new EmbedBuilder().setTitle("📋 Parts Catalog — Tokyo Drift Customs").setColor(COLORS.dark).setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    for (const [cat, list] of Object.entries(grouped)) embed.addFields({ name: cat, value: list.join("\n").slice(0, 1024) });
    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
