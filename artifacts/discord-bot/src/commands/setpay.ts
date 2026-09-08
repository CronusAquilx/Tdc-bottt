import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags
} from "discord.js";
import { db, getProfile, getUserRole, getGuildConfig, saveDatabaseSnapshot } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("setpay")
  .setDescription("Manually adjust one crew member's pay (manager only)")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("The mechanic or manager to update")
      .setRequired(true)
  )
  .addNumberOption(o =>
    o.setName("commission")
      .setDescription("Set weekly commission dollars, e.g. 678942")
      .setRequired(false)
      .setMinValue(0)
  )
  .addNumberOption(o =>
    o.setName("manager-cut")
      .setDescription("Set this manager's crew cut dollars for this week")
      .setRequired(false)
      .setMinValue(0)
  )
  .addNumberOption(o =>
    o.setName("commission-rate")
      .setDescription("Set commission rate as a decimal, e.g. 0.3 = 30%")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(1)
  )
  .addNumberOption(o =>
    o.setName("manager-rate")
      .setDescription("Set one manager's crew-cut percentage, e.g. 25 = 25%")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(100)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await requireRole(interaction, "manager"))) return;

  const target         = interaction.options.getUser("user", true);
  const commission     = interaction.options.getNumber("commission");
  const managerCut     = interaction.options.getNumber("manager-cut");
  const commissionRate = interaction.options.getNumber("commission-rate");
  const managerRate    = interaction.options.getNumber("manager-rate");

  if (
    commission === null &&
    managerCut === null &&
    commissionRate === null &&
    managerRate === null
  ) {
    await interaction.editReply({
      content: "❌ Provide at least one value: `commission`, `manager-cut`, `commission-rate`, or `manager-rate`."
    });
    return;
  }

  const profile = await getProfile(target.id);
  if (!profile) {
    await interaction.editReply({
      content: `❌ <@${target.id}> has no profile yet. Register them with \`/crew add\` or \`/setrank\` first.`
    });
    return;
  }

  if (managerCut !== null || managerRate !== null) {
    const targetRole = await getUserRole(target.id);
    if (targetRole !== "manager" && targetRole !== "owner") {
      await interaction.editReply({
        content: `❌ <@${target.id}> is not registered as a manager or owner. Assign them with \`/setrank\` first.`
      });
      return;
    }
  }

  const updates: string[] = [];
  const args: (string | number)[] = [];

  // Snapshot the current totals so a manual amount is additive and new orders
  // continue calculating on top of it instead of replacing the adjustment.
  const SINCE_RESET_SQL =
    "datetime(COALESCE(completed_at, created_at)) >= " +
    "datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))";
  const DONE_STATUSES = "status IN ('complete', 'approved', 'paid')";

  if (commission !== null) {
    const snapR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0)
            FROM orders
            WHERE mechanic_id = ? AND ${DONE_STATUSES} AND ${SINCE_RESET_SQL}`,
      args: [target.id]
    });
    const labourSnapshot = Number(snapR.rows[0]?.[0] ?? 0);
    updates.push("commission_adjustment = ?", "commission_labour_snapshot = ?");
    args.push(commission, labourSnapshot);
  }

  if (managerCut !== null) {
    const snapR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0)
            FROM orders
            WHERE ${DONE_STATUSES}
              AND ${SINCE_RESET_SQL}
              AND mechanic_id != ?
              AND role_level IN ('mechanic', 'trainer')`,
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

  if (managerRate !== null) {
    updates.push("manager_override_rate = ?");
    args.push(managerRate / 100);
  }

  args.push(target.id);
  await db.execute({
    sql: `UPDATE profiles SET ${updates.join(", ")} WHERE discord_id = ?`,
    args
  });
  await saveDatabaseSnapshot();

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Crew Member", value: `<@${target.id}> — ${profile.display_name}`, inline: false }
  ];

  if (commission !== null) {
    fields.push({
      name: "Weekly Commission Set",
      value: `${money(profile.commission_adjustment ?? 0)} → **${money(commission)}**`,
      inline: true
    });
  }

  if (managerCut !== null) {
    fields.push({
      name: "Manager Cut Set",
      value: `${money(profile.manager_cut_adjustment ?? 0)} → **${money(managerCut)}**`,
      inline: true
    });
  }

  if (commissionRate !== null) {
    fields.push({
      name: "Commission Rate Updated",
      value: `${(profile.commission_rate * 100).toFixed(0)}% → **${(commissionRate * 100).toFixed(0)}%**`,
      inline: true
    });
  }

  if (managerRate !== null) {
    fields.push({
      name: "Manager Crew Cut Updated",
      value: `${((profile.manager_override_rate ?? 0.20) * 100).toFixed(1)}% → **${managerRate.toFixed(1)}%**`,
      inline: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("💸  Pay Updated")
    .setColor(COLORS.approved)
    .addFields(...fields)
    .setDescription(
      "✅ Changes saved. The update applies only to the selected crew member.\n" +
      (commission !== null ? `> Weekly commission: **${money(commission)}**\n` : "") +
      (managerCut !== null ? `> Manager cut this week: **${money(managerCut)}**\n` : "") +
      (commissionRate !== null ? `> Commission rate: **${(commissionRate * 100).toFixed(0)}%**\n` : "") +
      (managerRate !== null ? `> Manager crew-cut rate: **${managerRate.toFixed(1)}%**\n` : "")
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  try {
    if (!interaction.guild) return;
    const config = await getGuildConfig(interaction.guild.id);
    if (!config?.log_channel_id) return;
    const channel = await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (channel?.isTextBased()) await (channel as any).send({ embeds: [embed] });
  } catch {
    // The pay update is already saved; logging failure should not fail the command.
  }
}