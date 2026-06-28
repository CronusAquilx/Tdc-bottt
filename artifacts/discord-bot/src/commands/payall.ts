import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Guild
} from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("payall")
  .setDescription("Process weekly payout for ALL crew and post payday announcement (owner only)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const embed = await buildPayallSummaryEmbed(weekStart(), interaction.guild ?? undefined);
  if (!embed) {
    await interaction.editReply({ content: "❌ No unpaid completed orders this week." });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("payall:confirm").setLabel("✅ Process All Payouts + Announce Payday").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("payall:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function buildPayallSummaryEmbed(ws: string, guild?: Guild): Promise<EmbedBuilder | null> {
  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
    args: [ws]
  });
  if (!ordersR.rows.length) return null;

  const mechanicMap = new Map<string, { name: string; rate: number; labour: number; orders: number; revenue: number }>();
  for (const row of ordersR.rows) {
    const mid    = String(row[0]);
    const labour = Number(row[1] ?? 0);
    const total  = Number(row[2] ?? 0);
    const name   = String(row[3] ?? "");
    const rate   = Number(row[4] ?? 0.3);
    if (!mechanicMap.has(mid)) mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0 });
    const e = mechanicMap.get(mid)!;
    e.labour += labour; e.orders += 1; e.revenue += total;
  }

  // Also include anyone with mechanic/trainer guild roles (even if no orders this week)
  if (guild) {
    try {
      const config = await getGuildConfig(guild.id);
      const roleIds = [
        ...splitRoleIds(config?.mechanic_role_id),
        ...splitRoleIds(config?.trainer_role_id)
      ];
      for (const roleId of roleIds) {
        try {
          const role = await guild.roles.fetch(roleId).catch(() => null);
          if (!role) continue;
          for (const [memberId, member] of role.members) {
            if (mechanicMap.has(memberId)) continue;
            const profile = await getProfile(memberId);
            const name = profile?.display_name ?? member.displayName;
            const rate = profile?.commission_rate ?? 0.3;
            mechanicMap.set(memberId, { name, rate, labour: 0, orders: 0, revenue: 0 });
          }
        } catch { /* role not found */ }
      }
    } catch { /* ignore */ }
  }

  let grandCommission = 0;
  let totalRevenue    = 0;
  const payLines: string[] = [];

  for (const [, m] of mechanicMap) {
    const commission  = m.labour * m.rate;
    grandCommission  += commission;
    totalRevenue     += m.revenue;
    payLines.push(`**${m.name}** · ${m.orders} orders · ${(m.rate * 100).toFixed(0)}% → **${money(commission)}**`);
  }

  if (!payLines.length) return null;

  const managersR = await db.execute(
    "SELECT p.discord_id, p.display_name, p.manager_override_rate FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
  );
  const managerLines: string[] = [];
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const overrideRate = Number(row[2] ?? 0.20);
    const cut          = grandCommission * overrideRate;
    if (overrideRate > 0) {
      managerLines.push(`**${String(row[1] ?? "")}** · ${(overrideRate * 100).toFixed(0)}% of pool → **${money(cut)}**`);
      totalManagerCuts += cut;
    }
  }

  const totalToBill = grandCommission + totalManagerCuts;

  const embed = new EmbedBuilder()
    .setTitle("💸  WEEKLY PAYROLL SUMMARY")
    .setColor(COLORS.primary)
    .setDescription(
      `**Pay period:** Week of \`${ws}\`\n` +
      `**Total revenue:** ${money(totalRevenue)}\n\n` +
      "Review all payouts below, then click **Process All Payouts** to confirm.\n" +
      "⚠️ This will **reset everyone's weekly stats** and post a payday announcement."
    )
    .addFields(
      { name: `🔩 Crew Commissions (${mechanicMap.size} people)`, value: payLines.join("\n") || "None", inline: false }
    );

  if (managerLines.length) {
    embed.addFields({ name: "👔 Manager Override Cuts", value: managerLines.join("\n"), inline: false });
  }

  embed.addFields(
    { name: "💰 Total to Bill Company", value: `**${money(totalToBill)}**`, inline: true },
    { name: "📋 Total Orders", value: String(ordersR.rows.length), inline: true }
  );

  embed.setFooter({ text: FOOTER }).setTimestamp();
  return embed;
}

export async function processPayall(
  guild: Guild | null,
  ws: string,
  paidById: string
): Promise<{ grandCommission: number; totalRevenue: number; mechanicCount: number; totalToBill: number } | null> {
  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
    args: [ws]
  });
  if (!ordersR.rows.length) return null;

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

  let grandCommission = 0;
  let totalRevenue    = 0;
  const { randomUUID } = await import("../lib/utils.js");

  for (const [mid, m] of mechanicMap) {
    const commission = m.labour * m.rate;
    grandCommission += commission;
    totalRevenue    += m.revenue;
    const payoutId = randomUUID();
    const weekEnd = new Date(new Date(ws).getTime() + 6 * 86400000).toISOString().split("T")[0];
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, mid, ws, commission, m.orders, m.hours, m.orders, paidById]
    });
  }

  // Mark all unpaid complete orders as paid
  await db.execute({
    sql: "UPDATE orders SET status = 'paid', completed_at = COALESCE(completed_at, datetime('now')) WHERE status IN ('complete','approved') AND DATE(created_at) >= ?",
    args: [ws]
  });

  // Reset weekly stats for everyone
  await db.execute("UPDATE profiles SET hours_worked_this_week = 0");

  // Reset order number counter
  const { setSetting } = await import("../db.js");
  await setSetting("order_number_reset_ts", new Date().toISOString());

  // Manager cuts
  const managersR = await db.execute(
    "SELECT discord_id, manager_override_rate FROM profiles INNER JOIN user_roles USING (discord_id) WHERE role IN ('manager','owner')"
  );
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const overrideRate = Number(row[1] ?? 0.20);
    totalManagerCuts += grandCommission * overrideRate;
  }

  return {
    grandCommission,
    totalRevenue,
    mechanicCount: mechanicMap.size,
    totalToBill: grandCommission + totalManagerCuts
  };
}
