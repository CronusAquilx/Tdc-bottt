import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Guild, TextChannel
} from "discord.js";
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
  await interaction.deferReply({ ephemeral: true });

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
  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
    args: [ws]
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
          for (const [memberId] of role.members) {
            if (mechanicMap.has(memberId)) continue;
            const profile = await getProfile(memberId);
            const name = profile?.display_name ?? "Unknown";
            const rate = profile?.commission_rate ?? 0.3;
            const hours = profile?.hours_worked_this_week ?? 0;
            mechanicMap.set(memberId, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
          }
        } catch { /* role not found */ }
      }
    } catch { /* ignore */ }
  }

  if (!mechanicMap.size) return null;

  // Pull commission_adjustment overrides
  const adjustSummaryR = await db.execute(
    "SELECT discord_id, commission_adjustment FROM profiles WHERE commission_adjustment > 0"
  );
  const adjustSummaryMap = new Map<string, number>();
  for (const row of adjustSummaryR.rows) {
    adjustSummaryMap.set(String(row[0] ?? ""), Number(row[1] ?? 0));
  }

  let grandCommission = 0;
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const payLines: string[] = [];

  for (const [mid, m] of mechanicMap) {
    const adjustment = adjustSummaryMap.get(mid) ?? 0;
    // commission_adjustment is ADDITIVE — stacks on top of order-based commission
    const commission = m.labour * m.rate + adjustment;
    grandCommission += commission;
    totalLabour     += m.labour;
    totalRevenue    += m.revenue;
    const hrsNote    = m.hours > 0 ? ` · ${m.hours.toFixed(1)}h` : "";
    const rateNote   = adjustment > 0
      ? `${(m.rate * 100).toFixed(0)}% + $${Math.round(adjustment).toLocaleString()} bonus`
      : `${(m.rate * 100).toFixed(0)}%`;
    payLines.push(`**${m.name}** · ${m.orders} orders${hrsNote} · ${rateNote} → **${money(commission)}**`);
  }

  if (!payLines.length) return null;

  // Manager cuts — percentage-based + additive manual bonus
  const managersR = await db.execute(
    "SELECT p.discord_id, p.display_name, p.manager_override_rate, p.manager_cut_adjustment FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
  );
  const managerLines: string[] = [];
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const manualBonus  = Number(row[3] ?? 0);
    const overrideRate = Number(row[2] ?? 0.20);
    // manager_cut_adjustment is ADDITIVE — stacks on top of % cut
    const cut          = totalLabour * overrideRate + manualBonus;
    if (cut > 0) {
      const bonusPart = manualBonus > 0 ? ` + ${money(manualBonus)} bonus` : "";
      const label = `**${String(row[1] ?? "")}** · ${(overrideRate * 100).toFixed(0)}% of labour${bonusPart} → **${money(cut)}**`;
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
): Promise<{ grandCommission: number; totalRevenue: number; mechanicCount: number; totalToBill: number; payouts: Array<{ mechanicId: string; amount: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }> } | null> {
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
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const { randomUUID } = await import("../lib/utils.js");

  const adjustR = await db.execute(
    "SELECT discord_id, commission_adjustment FROM profiles WHERE commission_adjustment > 0"
  );
  const adjustMap = new Map<string, number>();
  for (const row of adjustR.rows) {
    adjustMap.set(String(row[0] ?? ""), Number(row[1] ?? 0));
  }

  // Fetch sales channel IDs for notification
  const salesChanR = await db.execute(
    "SELECT discord_id, sales_channel_id FROM profiles"
  );
  const salesChanMap = new Map<string, string | null>();
  for (const row of salesChanR.rows) {
    salesChanMap.set(String(row[0] ?? ""), row[1] ? String(row[1]) : null);
  }

  const payoutResults: Array<{ mechanicId: string; amount: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }> = [];

  for (const [mid, m] of mechanicMap) {
    const adjustment  = adjustMap.get(mid) ?? 0;
    // commission_adjustment is ADDITIVE — stacks on top of order-based commission
    const commission  = m.labour * m.rate + adjustment;
    grandCommission  += commission;
    totalLabour      += m.labour;
    totalRevenue     += m.revenue;
    const payoutId = randomUUID();
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, mid, ws, commission, m.orders, m.hours, m.orders, paidById]
    });
    payoutResults.push({
      mechanicId: mid,
      amount: commission,
      orders: m.orders,
      hours: m.hours,
      name: m.name,
      salesChanId: salesChanMap.get(mid) ?? null,
      rate: m.rate
    });
  }

  // Mark all unpaid complete orders as paid
  await db.execute({
    sql: "UPDATE orders SET status = 'paid', completed_at = COALESCE(completed_at, datetime('now')) WHERE status IN ('complete','approved') AND DATE(created_at) >= ?",
    args: [ws]
  });

  // Reset weekly stats + clear manual pay adjustments for everyone
  await db.execute("UPDATE profiles SET hours_worked_this_week = 0, commission_adjustment = 0, manager_cut_adjustment = 0");

  // Reset order number counter
  const { setSetting } = await import("../db.js");
  await setSetting("order_number_reset_ts", new Date().toISOString());

  // Manager cuts — percentage of total labour + additive manual bonus
  const managersR = await db.execute(
    "SELECT discord_id, manager_override_rate, manager_cut_adjustment FROM profiles INNER JOIN user_roles USING (discord_id) WHERE role IN ('manager','owner')"
  );
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const manualBonus  = Number(row[2] ?? 0);
    const overrideRate = Number(row[1] ?? 0.20);
    // manager_cut_adjustment is ADDITIVE — stacks on top of % cut
    totalManagerCuts  += totalLabour * overrideRate + manualBonus;
  }

  return {
    grandCommission,
    totalRevenue,
    mechanicCount: mechanicMap.size,
    totalToBill: grandCommission + totalManagerCuts,
    payouts: payoutResults
  };
}
