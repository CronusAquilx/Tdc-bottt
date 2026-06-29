import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags
} from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("setpay")
  .setDescription("Manually set a mechanic's weekly commission and/or manager cut (manager only)")
  .addUserOption(o =>
    o.setName("user").setDescription("The mechanic or manager to update").setRequired(true)
  )
  .addNumberOption(o =>
    o.setName("commission")
      .setDescription("Set their weekly commission dollar amount (e.g. 678942)")
      .setRequired(false)
      .setMinValue(0)
  )
  .addNumberOption(o =>
    o.setName("manager-cut")
      .setDescription("Set their manager cut dollar amount for this week (managers only)")
      .setRequired(false)
      .setMinValue(0)
  )
  .addNumberOption(o =>
    o.setName("commission-rate")
      .setDescription("Also update their commission % rate (0.0–1.0, e.g. 0.3 = 30%)")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await requireRole(interaction, "manager"))) return;

  const target         = interaction.options.getUser("user", true);
  const commission     = interaction.options.getNumber("commission");
  const managerCut     = interaction.options.getNumber("manager-cut");
  const commissionRate = interaction.options.getNumber("commission-rate");

  if (commission === null && managerCut === null && commissionRate === null) {
    await interaction.editReply({ content: "❌ Please provide at least one value to set (`commission`, `manager-cut`, or `commission-rate`)." });
    return;
  }

  const profile = await getProfile(target.id);
  if (!profile) {
    await interaction.editReply({ content: `❌ <@${target.id}> has no profile yet. Register them with \`/crew add\` or \`/setrank\` first.` });
    return;
  }

  const updates: string[] = [];
  const args: any[] = [];

  // Snapshot the current labour totals at the moment setpay is run.
  // Commission going forward = adjustment + (labour AFTER this snapshot) × rate.
  // This means the amount you set is locked in, and new orders add on top cleanly.
  const SINCE_RESET_SQL = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const DONE_STATUSES   = `status IN ('complete', 'approved', 'paid')`;

  if (commission !== null) {
    // Snapshot how much labour this mechanic has done so far this pay period
    const snapR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE mechanic_id = ? AND ${DONE_STATUSES} AND ${SINCE_RESET_SQL}`,
      args: [target.id]
    });
    const labourSnapshot = Number(snapR.rows[0]?.[0] ?? 0);
    updates.push("commission_adjustment = ?", "commission_labour_snapshot = ?");
    args.push(commission, labourSnapshot);
  }
  if (managerCut !== null) {
    // Snapshot the total crew labour so far this pay period
    const snapR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE ${DONE_STATUSES} AND ${SINCE_RESET_SQL} AND mechanic_id != ? AND role_level IN ('mechanic', 'trainer')`,
      args: [target.id]
    });
    const managerLabourSnapshot = Number(snapR.rows[0]?.[0] ?? 0);
    updates.push("manager_cut_adjustment = ?", "manager_labour_snapshot = ?");
    args.push(managerCut, managerLabourSnapshot);
  }
  if (commissionRate !== null) {
    updates.push("commission_rate = ?");
    args.push(commissionRate);
  }

  args.push(target.id);
  await db.execute({
    sql: `UPDATE profiles SET ${updates.join(", ")} WHERE discord_id = ?`,
    args
  });

  const updatedProfile = await getProfile(target.id);

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Mechanic", value: `<@${target.id}> — ${profile.display_name}`, inline: false }
  ];

  if (commission !== null) {
    fields.push({
      name: "💵 Weekly Commission Set",
      value: `${money(profile.commission_adjustment ?? 0)} → **${money(commission)}**`,
      inline: true
    });
  }
  if (managerCut !== null) {
    fields.push({
      name: "👔 Manager Cut Set",
      value: `${money(profile.manager_cut_adjustment ?? 0)} → **${money(managerCut)}**`,
      inline: true
    });
  }
  if (commissionRate !== null) {
    fields.push({
      name: "📊 Commission Rate Updated",
      value: `${(profile.commission_rate * 100).toFixed(0)}% → **${(commissionRate * 100).toFixed(0)}%**`,
      inline: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("💸  Pay Updated")
    .setColor(COLORS.approved)
    .addFields(...fields)
    .setDescription(
      "✅ Changes saved. Their commission will reflect these amounts on payday.\n" +
      (commission !== null ? `> 💵 Weekly commission: **${money(commission)}**\n` : "") +
      (managerCut !== null ? `> 👔 Manager cut: **${money(managerCut)}**\n` : "") +
      (commissionRate !== null ? `> 📊 Rate going forward: **${(commissionRate * 100).toFixed(0)}%**\n` : "")
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
