import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { EmbedBuilder } from "discord.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("analytics")
  .setDescription("Shop analytics (manager+)")
  .addUserOption(o => o.setName("mechanic").setDescription("Specific mechanic"))
  .addStringOption(o =>
    o.setName("period").setDescription("Time period")
      .addChoices(
        { name: "This Week", value: "week" },
        { name: "This Month", value: "month" },
        { name: "This Year", value: "year" }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: false });

  const period = interaction.options.getString("period") ?? "week";
  const targetUser = interaction.options.getUser("mechanic");
  const now = new Date();
  let dateFrom: string;
  let periodLabel: string;

  if (period === "week") {
    dateFrom = weekStart();
    periodLabel = `Week of ${new Date(dateFrom).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  } else if (period === "month") {
    dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    periodLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } else {
    dateFrom = `${now.getFullYear()}-01-01`;
    periodLabel = String(now.getFullYear());
  }

  const r = targetUser
    ? await db.execute({ sql: "SELECT mechanic_id, total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [targetUser.id, dateFrom] })
    : await db.execute({ sql: "SELECT mechanic_id, total, labour FROM orders WHERE status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [dateFrom] });

  const totalRevenue = r.rows.reduce((s, row) => s + Number(row[1] ?? 0), 0);

  // Build per-mechanic map with their individual commission rates
  const mechMap: Record<string, { name: string; orders: number; revenue: number; commission: number; rate: number }> = {};
  for (const row of r.rows) {
    const mid = String(row[0]);
    if (!mechMap[mid]) {
      const p = await getProfile(mid);
      mechMap[mid] = { name: p?.display_name ?? "Unknown", orders: 0, revenue: 0, commission: 0, rate: p?.commission_rate ?? 0.4 };
    }
    mechMap[mid].orders++;
    mechMap[mid].revenue += Number(row[1] ?? 0);
    mechMap[mid].commission += Number(row[2] ?? 0) * mechMap[mid].rate;
  }

  const totalCommission = Object.values(mechMap).reduce((s, m) => s + m.commission, 0);
  const avgOrderValue = r.rows.length ? totalRevenue / r.rows.length : 0;

  const sorted = Object.values(mechMap).sort((a, b) => b.revenue - a.revenue);
  const top = sorted[0] ?? { name: "N/A", orders: 0, revenue: 0 };

  const hoursR = await db.execute(
    "SELECT SUM(hours_worked_this_week) as total FROM profiles p JOIN user_roles ur ON ur.discord_id = p.discord_id WHERE ur.role = 'mechanic'"
  );
  const teamHours = Number(hoursR.rows[0]?.[0] ?? 0);

  const embed = new EmbedBuilder()
    .setTitle(`📊  Team Analytics  ·  ${periodLabel}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Total Orders", value: String(r.rows.length), inline: true },
      { name: "Total Revenue", value: money(totalRevenue), inline: true },
      { name: "Total Commission Paid Out", value: money(totalCommission), inline: true },
      { name: "Avg Order Value", value: money(avgOrderValue), inline: true },
      { name: "Team Hours", value: `${teamHours.toFixed(1)} hrs`, inline: true },
      { name: "Top Performer", value: `${top.name} — ${top.orders} orders · ${money(top.revenue)}`, inline: false },
      ...(sorted.length
        ? [{ name: "Mechanic Breakdown", value: sorted.map(m => `**${m.name}**: ${m.orders} orders · ${money(m.revenue)} · Commission: ${money(m.commission)}`).join("\n").slice(0, 1024), inline: false }]
        : [])
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
