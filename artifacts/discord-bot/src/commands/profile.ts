import { SlashCommandBuilder, ChatInputCommandInteraction, AttachmentBuilder } from "discord.js";
import { db, getProfile, getUserRole } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { drawProfileCard } from "../lib/profilecard.js";
import type { CrewRank } from "../lib/profilecard.js";

export const data = new SlashCommandBuilder()
  .setName("profile")
  .setDescription("View a crew member's ID card")
  .addUserOption(o =>
    o.setName("member")
      .setDescription("The crew member to view (leave blank for yourself)")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "mechanic"))) return;
  await interaction.deferReply();

  const target = interaction.options.getUser("member") ?? interaction.user;
  const profile = await getProfile(target.id);
  if (!profile) {
    await interaction.editReply({ content: "❌ That user isn't in the crew. Add them via `/crew add` first." });
    return;
  }

  const rank = (await getUserRole(target.id) ?? "mechanic") as CrewRank;

  // Orders this week
  const weekStart = getWeekStart();
  const ordersR = await db.execute({
    sql: `SELECT COUNT(*), COALESCE(SUM(total), 0) FROM orders
          WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?`,
    args: [target.id, weekStart]
  });
  const ordersThisWeek = Number(ordersR.rows[0]?.[0] ?? 0);

  // Total revenue all time
  const totalR = await db.execute({
    sql: `SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete'`,
    args: [target.id]
  });
  const totalRevenue = Number(totalR.rows[0]?.[0] ?? 0);

  const card = drawProfileCard({
    displayName:    profile.display_name,
    rank,
    discordId:      target.id,
    commissionRate: profile.commission_rate,
    hoursThisWeek:  profile.hours_worked_this_week,
    ordersThisWeek,
    totalRevenue,
    status:         profile.status,
    memberSince:    new Date(profile.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
  });

  const attachment = new AttachmentBuilder(card, { name: "profile.png" });
  await interaction.editReply({ files: [attachment] });
}

function getWeekStart(): string {
  const now  = new Date();
  const day  = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const d    = new Date(now);
  d.setUTCDate(now.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}
