import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildAnalyticsEmbed } from "../lib/embeds.js";
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
    ? await db.execute({ sql: "SELECT mechanic_id, total, labour FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid') AND DATE(created_at) >= ?", args: [targetUser.id, dateFrom] })
    : await db.execute({ sql: "SELECT mechanic_id, total, labour FROM orders WHERE status IN ('approved','paid') AND DATE(created_at) >= ?", args: [dateFrom] });

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

  const embed = buildAnalyticsEmbed(
    `Team Analytics · ${periodLabel}`,
    top.name, top.orders, top.revenue,
    avgOrderValue, r.rows.length, totalRevenue, totalCommission,
    teamHours,
    sorted.map(m => ({ name: m.name, orders: m.orders, max: top.orders }))
  );
  await interaction.editReply({ embeds: [embed] });
}
