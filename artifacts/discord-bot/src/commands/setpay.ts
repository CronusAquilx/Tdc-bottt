import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { db, getProfile, getUserRole } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("setpay")
  .setDescription("Quickly adjust one manager's crew cut")
  .addSubcommand(s =>
    s.setName("manager")
      .setDescription("Set the crew cut for one manager only")
      .addUserOption(o =>
        o.setName("user")
          .setDescription("The manager whose cut you want to change")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("percentage")
          .setDescription("Crew cut percentage, for example 20 = 20%")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const percentage = interaction.options.getNumber("percentage", true);
  const targetRole = await getUserRole(target.id);

  if (targetRole !== "manager" && targetRole !== "owner") {
    await interaction.editReply({
      content: `❌ <@${target.id}> is not registered as a manager. Assign them with \`/setrank\` first.`
    });
    return;
  }

  const profile = await getProfile(target.id);
  if (!profile) {
    await interaction.editReply({
      content: `❌ <@${target.id}> has no crew profile yet. Run \`/setrank\` for them first.`
    });
    return;
  }

  const newRate = percentage / 100;
  const oldRate = profile.manager_override_rate ?? 0.20;

  await db.execute({
    sql: "UPDATE profiles SET manager_override_rate = ? WHERE discord_id = ?",
    args: [newRate, target.id]
  });

  const ws = weekStart();
  const ordersR = await db.execute({
    sql: `SELECT o.labour, p.commission_rate
          FROM orders o
          JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
    args: [ws]
  });
  const crewPool = ordersR.rows.reduce(
    (sum, row) => sum + Number(row[0] ?? 0) * Number(row[1] ?? 0.3),
    0
  );

  const formatRate = (rate: number) =>
    `${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%`;

  const embed = new EmbedBuilder()
    .setTitle("👔  Manager Crew Cut Updated")
    .setColor(COLORS.approved)
    .setDescription(
      `✅ Updated **${profile.display_name}** only. This does not change any other manager's cut.`
    )
    .addFields(
      { name: "Manager", value: `<@${target.id}>`, inline: true },
      { name: "Old Cut", value: formatRate(oldRate), inline: true },
      { name: "New Cut", value: formatRate(newRate), inline: true },
      { name: "Applies To", value: "This manager's share of the crew commission pool", inline: false },
      { name: "Estimated This Week", value: money(crewPool * newRate), inline: true },
      { name: "Current Crew Pool", value: money(crewPool), inline: true }
    )
    .setFooter({ text: `${FOOTER}  ·  Use /setpay manager to change one manager` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  try {
    if (!interaction.guild) return;
    const config = await (await import("../db.js")).getGuildConfig(interaction.guild.id);
    if (!config?.log_channel_id) return;
    const channel = await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (channel?.isTextBased()) await (channel as any).send({ embeds: [embed] });
  } catch {
    // The rate is already saved; logging failure should not make the command fail.
  }
}