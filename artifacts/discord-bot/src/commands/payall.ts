import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Guild, TextChannel
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("payall")
  .setDescription("Process weekly payout for ALL crew and notify mechanics (manager+)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = await buildPayallSummaryEmbed(weekStart(), interaction.guild ?? undefined);
  if (!embed) {
    await interaction.editReply({ content: "❌ No unpaid completed orders this week." });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("payall:confirm").setLabel("💸  Pay All + Notify Crew").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("payall:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function buildPayallSummaryEmbed(ws: string, guild?: Guild): Promise<EmbedBuilder | null> {
  // Always use order_number_reset_ts as the pay-period boundary so it stays in sync
  // with the snapshot formula used everywhere else (getCommissionData, mysales, etc.)
  const SINCE_RESET = `datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND ${SINCE_RESET}`,
    args: []
  });

  const mechanicMap = new Map<string, { name: string; rate: number; labour: number; orders: number; revenue: number; hours: number }>();
  for (const row of ordersR.rows) {
    const mid    = String(row[0]);
    const labour = Number(row[1] ?? 0);
    const total  = Number(row[2] ?? 0);
    const name   = String(row[3] ?? "");
    const rate   = Number(row[4] ?? 0.3);
    const hours  = Number(row[5] ?? 0);
    if (!mechanicMap.has(mid)) mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
    const e = mechanicMap.get(mid)!;
    e.labour += labour; e.orders += 1; e.revenue += total;
  }

  // Pull ALL profiles — the source of truth for who is in the crew.
  // This ensures people with setpay (commission_adjustment > 0) show up even with no orders.
  const allProfilesR = await db.execute(
    "SELECT discord_id, display_name, commission_rate, hours_worked_this_week, commission_adjustment, commission_labour_snapshot FROM profiles"
  );
  const adjustSummaryMap = new Map<string, { adj: number; snapshot: number }>();
  for (const row of allProfilesR.rows) {
    const mid = String(row[0] ?? "");
    const adj      = Number(row[4] ?? 0);
    const snapshot = Number(row[5] ?? 0);
    adjustSummaryMap.set(mid, { adj, snapshot });
    if (!mechanicMap.has(mid)) {
      mechanicMap.set(mid, {
        name:    String(row[1] ?? "Unknown"),
        rate:    Number(row[2] ?? 0.3),
        labour:  0,
        orders:  0,
        revenue: 0,
        hours:   Number(row[3] ?? 0)
      });
    }
  }

  if (!mechanicMap.size) return null;

  let grandCommission = 0;
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const payLines: string[] = [];

  for (const [mid, m] of mechanicMap) {
    const { adj = 0, snapshot = 0 } = adjustSummaryMap.get(mid) ?? {};
    const labourAfterSetpay = Math.max(0, m.labour - snapshot);
    const commission = adj > 0
      ? adj + labourAfterSetpay * m.rate
      : m.labour * m.rate;
    grandCommission += commission;
    totalLabour     += m.labour;
    totalRevenue    += m.revenue;
    const hrsNote    = m.hours > 0 ? ` · ${m.hours.toFixed(1)}h` : "";
    const rateNote   = adj > 0
      ? `set $${Math.round(adj).toLocaleString()} + new orders`
      : `${(m.rate * 100).toFixed(0)}%`;
    payLines.push(`**${m.name}** · ${m.orders} orders${hrsNote} · ${rateNote} → **${money(commission)}**`);
  }

  if (!payLines.length) return null;

  // Manager cuts — snapshot-based formula (same as getCommissionData)
  const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const managersR = await db.execute(
    "SELECT p.discord_id, p.display_name, p.manager_override_rate, p.manager_cut_adjustment, p.manager_labour_snapshot FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
  );
  const managerLines: string[] = [];
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const managerId    = String(row[0] ?? "");
    const manualBonus  = Number(row[3] ?? 0);
    const managerSnap  = Number(row[4] ?? 0);
    const overrideRate = Number(row[2] ?? 0.20);
    // Fetch crew labour (mechanic/trainer role_level orders, excluding the manager's own)
    const crewLabourR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
      args: [managerId]
    });
    const crewLabour = Number(crewLabourR.rows[0]?.[0] ?? 0);
    const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
    const cut = manualBonus > 0
      ? manualBonus + crewAfterSnap * overrideRate
      : crewLabour * overrideRate;
    if (cut > 0) {
      const rateLabel = manualBonus > 0
        ? `set ${money(manualBonus)} + new crew orders`
        : `${(overrideRate * 100).toFixed(0)}% of crew labour`;
      const label = `**${String(row[1] ?? "")}** · ${rateLabel} → **${money(cut)}**`;
      managerLines.push(label);
      totalManagerCuts += cut;
    }
  }

  const totalToBill = grandCommission + totalManagerCuts;

  const embed = new EmbedBuilder()
    .setTitle("💸  WEEKLY PAYROLL SUMMARY")
    .setColor(0xffd700)
    .setDescription(
      `**Pay period:** Week of \`${ws}\`\n` +
      `**Total revenue:** ${money(totalRevenue)}\n\n` +
      "Review all payouts below. Click **Pay All + Notify Crew** to process payroll,\n" +
      "send pay messages to every sales channel, and start the new week.\n\n" +
      "⚠️ This will **mark all orders as paid** and **reset weekly stats**."
    )
    .addFields(
      { name: `🔩 Crew Commissions (${mechanicMap.size} people)`, value: payLines.join("\n") || "None", inline: false }
    );

  if (managerLines.length) {
    embed.addFields({ name: "👔 Manager Cuts", value: managerLines.join("\n"), inline: false });
  }

  embed.addFields(
    { name: "💰 Total to Bill Company", value: `**${money(totalToBill)}**`, inline: true },
    { name: "📋 Total Orders",          value: String(ordersR.rows.length),  inline: true }
  );

  embed.setFooter({ text: FOOTER }).setTimestamp();
  return embed;
}

/**
 * Posts the current payroll summary + Pay All button to a pay-logs channel.
 * Called when the pay-logs channel is created or when the auto-scheduler fires.
 */
export async function postPayLogPanel(channel: TextChannel, guild?: Guild): Promise<void> {
  const ws = weekStart();
  const embed = await buildPayallSummaryEmbed(ws, guild);

  if (!embed) {
    const waitEmbed = new EmbedBuilder()
      .setTitle("💸  WEEKLY PAYROLL PANEL")
      .setColor(0xffd700)
      .setDescription(
        `**Pay period:** Week of \`${ws}\`\n\n` +
        "No completed orders yet this week.\n" +
        "This panel will update when mechanics complete orders.\n\n" +
        "Run `/payall` or use **Schedule Pay Day** in the admin panel when ready."
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();
    await channel.send({ embeds: [waitEmbed] });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("payall:confirm").setLabel("💸  Pay All + Notify Crew").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("payall:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
}

export async function processPayall(
  guild: Guild | null,
  ws: string,
  paidById: string
): Promise<{
  grandCommission: number;
  totalRevenue: number;
  mechanicCount: number;
  totalToBill: number;
  payouts: Array<{ mechanicId: string; amount: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }>;
  notifyZero: Array<{ mechanicId: string; name: string; salesChanId: string; rate: number }>;
} | null> {
  const SINCE_RESET = `datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  // Orders-based mechanic map
  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND ${SINCE_RESET}`,
    args: []
  });

  const mechanicMap = new Map<string, { name: string; rate: number; labour: number; orders: number; revenue: number; hours: number }>();
  for (const row of ordersR.rows) {
    const mid    = String(row[0]);
    const labour = Number(row[1] ?? 0);
    const total  = Number(row[2] ?? 0);
    const name   = String(row[3] ?? "");
    const rate   = Number(row[4] ?? 0.3);
    const hours  = Number(row[5] ?? 0);
    if (!mechanicMap.has(mid)) mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
    const e = mechanicMap.get(mid)!;
    e.labour += labour; e.orders += 1; e.revenue += total;
  }

  // Pull ALL profiles:
  // - Build adjust/sales maps
  // - Add setpay-only people (adj > 0, no orders) to the paying list
  // - Collect everyone else with a sales channel for new-week-only notifications
  const allProfilesR = await db.execute(
    "SELECT discord_id, display_name, commission_rate, hours_worked_this_week, commission_adjustment, commission_labour_snapshot, sales_channel_id FROM profiles"
  );
  const adjustMap    = new Map<string, { adj: number; snapshot: number }>();
  const salesChanMap = new Map<string, string | null>();
  const notifyZero: Array<{ mechanicId: string; name: string; salesChanId: string; rate: number }> = [];

  for (const row of allProfilesR.rows) {
    const mid      = String(row[0] ?? "");
    const name     = String(row[1] ?? "Unknown");
    const rate     = Number(row[2] ?? 0.3);
    const hours    = Number(row[3] ?? 0);
    const adj      = Number(row[4] ?? 0);
    const snapshot = Number(row[5] ?? 0);
    const chanId   = row[6] ? String(row[6]) : null;

    adjustMap.set(mid, { adj, snapshot });
    salesChanMap.set(mid, chanId);

    if (!mechanicMap.has(mid)) {
      if (adj > 0) {
        // Has setpay but no completed orders this period — still gets paid
        mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
      } else if (chanId) {
        // $0 commission — add to new-week-only notification list
        notifyZero.push({ mechanicId: mid, name, salesChanId: chanId, rate });
      }
    }
  }

  // Nothing at all to process
  if (!mechanicMap.size && !notifyZero.length) return null;

  let grandCommission = 0;
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const { randomUUID } = await import("../lib/utils.js");
  const payoutResults: Array<{ mechanicId: string; amount: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }> = [];

  for (const [mid, m] of mechanicMap) {
    const { adj = 0, snapshot = 0 } = adjustMap.get(mid) ?? {};
    const labourAfterSetpay = Math.max(0, m.labour - snapshot);
    const commission = adj > 0
      ? adj + labourAfterSetpay * m.rate
      : m.labour * m.rate;
    grandCommission += commission;
    totalLabour     += m.labour;
    totalRevenue    += m.revenue;

    // Only write a DB payout record if there is actual money
    if (commission > 0) {
      const payoutId = randomUUID();
      await db.execute({
        sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
        args: [payoutId, mid, ws, Math.round(commission), m.orders, m.hours, m.orders, paidById]
      });
    }

    payoutResults.push({
      mechanicId: mid,
      amount: Math.round(commission),
      orders: m.orders,
      hours: m.hours,
      name: m.name,
      salesChanId: salesChanMap.get(mid) ?? null,
      rate: m.rate
    });
  }

  // Compute manager cuts BEFORE marking orders paid and BEFORE resetting snapshots
  const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const managersR = await db.execute(
    "SELECT discord_id, manager_override_rate, manager_cut_adjustment, manager_labour_snapshot FROM profiles INNER JOIN user_roles USING (discord_id) WHERE role IN ('manager','owner')"
  );
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const managerId    = String(row[0] ?? "");
    const overrideRate = Number(row[1] ?? 0.20);
    const manualBonus  = Number(row[2] ?? 0);
    const managerSnap  = Number(row[3] ?? 0);
    const crewLabourR  = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
      args: [managerId]
    });
    const crewLabour    = Number(crewLabourR.rows[0]?.[0] ?? 0);
    const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
    const cut = manualBonus > 0
      ? manualBonus + crewAfterSnap * overrideRate
      : crewLabour * overrideRate;
    totalManagerCuts += cut;
  }

  // Mark all unpaid complete orders as paid
  await db.execute({
    sql: `UPDATE orders SET status = 'paid', completed_at = COALESCE(completed_at, datetime('now')) WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE}`,
    args: []
  });

  // Full clear — delete all draft orders so the week truly resets
  await db.execute("DELETE FROM orders WHERE status = 'draft'");

  // Reset weekly stats + clear manual pay adjustments + snapshots for everyone
  await db.execute("UPDATE profiles SET hours_worked_this_week = 0, commission_adjustment = 0, manager_cut_adjustment = 0, commission_labour_snapshot = 0, manager_labour_snapshot = 0");

  // Record pay-period boundary
  const { setSetting } = await import("../db.js");
  await setSetting("order_number_reset_ts", new Date().toISOString());

  // Log the payout event
  const { logEvent } = await import("../lib/eventLog.js");
  logEvent({
    kind: "payout_processed",
    guildId: guild?.id,
    userId: paidById,
    amount: Math.round(grandCommission + totalManagerCuts),
    detail: `${mechanicMap.size} crew, ${ordersR.rows.length} orders, week ${ws}`
  });

  return {
    grandCommission,
    totalRevenue,
    mechanicCount: payoutResults.filter(p => p.amount > 0).length,
    totalToBill: grandCommission + totalManagerCuts,
    payouts: payoutResults,
    notifyZero
  };
}
