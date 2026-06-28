import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildDashboardEmbed, money, COLORS } from "../lib/embeds.js";
import { todayDate, weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

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

  // For commission calculation we MUST use order_number_reset_ts as the period boundary
  // so it matches the snapshot taken when /setpay was run. weekStart() and order_number_reset_ts
  // diverge after a mid-week payday, causing the snapshot formula to break.
  const SINCE_RESET_SQL = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  const [periodR, todayR, ytdR, resetPeriodR] = await Promise.all([
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [interaction.user.id, periodStart] }),
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) = ?", args: [interaction.user.id, today] }),
    db.execute({ sql: "SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [interaction.user.id, yearStart] }),
    // This is the authoritative pay-period query for commission (uses reset_ts not weekStart)
    db.execute({ sql: `SELECT total, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND ${SINCE_RESET_SQL}`, args: [interaction.user.id] })
  ]);

  const sum = (rows: any[]) => rows.reduce((s: any, row: any) => ({
    total: s.total + Number(row[0] ?? 0),
    labour: s.labour + Number(row[1] ?? 0)
  }), { total: 0, labour: 0 });

  const periodTotals    = sum(periodR.rows);
  const todayTotals     = sum(todayR.rows);
  const ytdTotals       = sum(ytdR.rows);
  const resetPeriodTotals = sum(resetPeriodR.rows);

  const rate       = profile.commission_rate;
  const adjustment = profile.commission_adjustment ?? 0;
  const snapshot   = profile.commission_labour_snapshot ?? 0;

  // Always use the reset-period labour for commission calculation so the snapshot formula works.
  // The display stats (orders count, revenue) still use the calendar-week/month period.
  const commLabour = period === "week" ? resetPeriodTotals.labour : periodTotals.labour;
  const labourAfterSetpay = Math.max(0, commLabour - (period === "week" ? snapshot : 0));
  const weekCommission = (adjustment > 0 && period === "week")
    ? adjustment + labourAfterSetpay * rate
    : commLabour * rate;

  const embed = buildDashboardEmbed(
    profile.display_name, profile.status,
    todayR.rows.length, todayTotals.total,
    periodR.rows.length, periodTotals.total,
    profile.hours_worked_this_week,
    weekCommission,
    ytdR.rows.length, ytdTotals.total,
    ytdTotals.labour * rate
  );

  // ── Manager commission section ───────────────────────────────────────────────
  // Check if this user has any mechanics assigned to them as manager
  const mechanicsR = await db.execute({
    sql: "SELECT discord_id, display_name, commission_rate FROM profiles WHERE manager_id = ?",
    args: [interaction.user.id]
  });

  if (mechanicsR.rows.length > 0) {
    // For each mechanic, fetch their orders for the pay period.
    // We use order_number_reset_ts for week calculations (matches payday logic),
    // and DATE >= periodStart for month calculations.
    const SINCE_RESET_MGR = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    let totalManagerCut = 0;
    const breakdownLines: string[] = [];

    for (const mRow of mechanicsR.rows) {
      const mId   = String(mRow[0] ?? "");
      const mName = String(mRow[1] ?? "Unknown");
      const mRate = Number(mRow[2] ?? 0.3);

      // Use the same boundary as payday for week, calendar period for month
      const ordersR = period === "week"
        ? await db.execute({ sql: `SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND ${SINCE_RESET_MGR}`, args: [mId] })
        : await db.execute({ sql: "SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND DATE(created_at) >= ?", args: [mId, periodStart] });

      const mLabour = ordersR.rows.reduce((s, r) => s + Number(r[0] ?? 0), 0);

      // Fetch mechanic profile for snapshot-aware commission (week only)
      const mProfile = period === "week" ? await getProfile(mId) : null;
      let mCommission: number;
      if (period === "week" && mProfile) {
        const mAdj      = mProfile.commission_adjustment ?? 0;
        const mSnapshot = mProfile.commission_labour_snapshot ?? 0;
        const mLabourAfter = Math.max(0, mLabour - mSnapshot);
        mCommission = mAdj > 0 ? mAdj + mLabourAfter * mRate : mLabour * mRate;
      } else {
        mCommission = mLabour * mRate;
      }

      // Manager cut is a % of the mechanic's crew-labour (not their commission)
      // Use manager_override_rate from this manager's profile; default 20%
      const overrideRate = profile.manager_override_rate ?? 0.20;
      const managerCut   = mLabour * overrideRate;
      totalManagerCut   += managerCut;

      if (mLabour > 0) {
        breakdownLines.push(`> **${mName}** — ${money(mCommission)} commission → your cut: **${money(managerCut)}**`);
      } else {
        breakdownLines.push(`> **${mName}** — no orders this ${period === "month" ? "month" : "week"}`);
      }
    }

    const periodLabel = period === "month" ? "Month" : "Week";
    embed.addFields({
      name: `👔 Manager Commission (This ${periodLabel})`,
      value:
        breakdownLines.join("\n") +
        `\n\n💵 **Total manager cut: ${money(totalManagerCut)}**\n` +
        `*You earn ${((profile.manager_override_rate ?? 0.20) * 100).toFixed(0)}% of each assigned mechanic's labour*`,
      inline: false
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
