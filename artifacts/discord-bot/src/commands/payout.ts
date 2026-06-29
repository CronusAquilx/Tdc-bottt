import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder
, MessageFlags} from "discord.js";
import { db, getProfile, getUserRole } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("payout")
  .setDescription("Check total unpaid commission")
  .addUserOption(o =>
    o.setName("mechanic").setDescription("Check a specific mechanic (manager+ only)")
  );

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "mechanic"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetUser = interaction.options.getUser("mechanic");
  const role = await getUserRole(interaction.user.id);
  const isManager = role === "owner" || role === "manager";

  if (targetUser && targetUser.id !== interaction.user.id && !isManager) {
    await interaction.editReply({ content: "❌ Only managers can check another mechanic's payout." });
    return;
  }

  const mechanicId = targetUser?.id ?? interaction.user.id;
  const profile = await getProfile(mechanicId);
  if (!profile) {
    await interaction.editReply({ content: "❌ Profile not found." });
    return;
  }

  const ws = weekStart();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const yearStart = `${now.getFullYear()}-01-01`;

  const [weekR, monthR, ytdR, allTimeR] = await Promise.all([
    db.execute({ sql: "SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?", args: [mechanicId, ws] }),
    db.execute({ sql: "SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?", args: [mechanicId, monthStart] }),
    db.execute({ sql: "SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?", args: [mechanicId, yearStart] }),
    db.execute({ sql: "SELECT labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved')", args: [mechanicId] })
  ]);

  const sumLabour = (rows: any[]) => rows.reduce((s: number, row: any) => s + Number(row[0] ?? 0), 0);
  const rate = profile.commission_rate;

  const weekLabour = sumLabour(weekR.rows);
  const monthLabour = sumLabour(monthR.rows);
  const ytdLabour = sumLabour(ytdR.rows);
  const allLabour = sumLabour(allTimeR.rows);

  const embed = new EmbedBuilder()
    .setTitle(`💵  COMMISSION SUMMARY  ·  ${profile.display_name}`)
    .setColor(COLORS.primary)
    .setDescription(`Commission rate: **${(rate * 100).toFixed(0)}%** of labour`)
    .addFields(
      { name: "This Week", value: `Labour: ${money(weekLabour)}\n**Cut: ${money(weekLabour * rate)}**`, inline: true },
      { name: "This Month", value: `Labour: ${money(monthLabour)}\n**Cut: ${money(monthLabour * rate)}**`, inline: true },
      { name: "YTD", value: `Labour: ${money(ytdLabour)}\n**Cut: ${money(ytdLabour * rate)}**`, inline: true },
      { name: "Orders This Week", value: String(weekR.rows.length), inline: true },
      { name: "Orders This Month", value: String(monthR.rows.length), inline: true },
      { name: "All Time Orders", value: String(allTimeR.rows.length), inline: true }
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
