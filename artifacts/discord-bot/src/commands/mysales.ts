import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildDashboardEmbed } from "../lib/embeds.js";
import { todayDate, weekStart } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("mysales")
  .setDescription("View your personal sales dashboard")
  .addStringOption(o =>
    o.setName("period").setDescription("Time period")
      .addChoices({ name: "This Week", value: "week" }, { name: "This Month", value: "month" })
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "mechanic"))) return;
  await interaction.deferReply({ ephemeral: true });

  const period = interaction.options.getString("period") ?? "week";
  const profile = await getProfile(interaction.user.id);
  if (!profile) { await interaction.editReply({ content: "❌ Profile not found." }); return; }

  const today = todayDate();
  const ws = weekStart();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const periodStart = period === "month" ? monthStart : ws;
  const yearStart = `${now.getFullYear()}-01-01`;

  const [periodR, todayR, ytdR] = await Promise.all([
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [interaction.user.id, periodStart] }),
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) = ?", args: [interaction.user.id, today] }),
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [interaction.user.id, yearStart] })
  ]);

  const sum = (rows: any[]) => rows.reduce((s: any, row: any) => ({
    total: s.total + Number(row[0] ?? 0),
    labour: s.labour + Number(row[1] ?? 0)
  }), { total: 0, labour: 0 });

  const periodTotals = sum(periodR.rows);
  const todayTotals = sum(todayR.rows);
  const ytdTotals = sum(ytdR.rows);

  const rate = profile.commission_rate;

  const embed = buildDashboardEmbed(
    profile.display_name, profile.status,
    todayR.rows.length, todayTotals.total,
    periodR.rows.length, periodTotals.total,
    profile.hours_worked_this_week,
    periodTotals.labour * rate,
    ytdR.rows.length, ytdTotals.total,
    ytdTotals.labour * rate
  );
  await interaction.editReply({ embeds: [embed] });
}
