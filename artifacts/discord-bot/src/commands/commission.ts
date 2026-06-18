import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("commission")
  .setDescription("Update a mechanic's commission rate (owner only)")
  .addUserOption(o => o.setName("user").setDescription("Target mechanic").setRequired(true))
  .addNumberOption(o =>
    o.setName("rate").setDescription("Rate 0.0 – 1.0").setRequired(true).setMinValue(0).setMaxValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const rate = interaction.options.getNumber("rate", true);
  const [profile, caller] = await Promise.all([getProfile(target.id), getProfile(interaction.user.id)]);
  if (!profile) { await interaction.editReply({ content: "❌ User not found." }); return; }
  await db.execute({ sql: "UPDATE profiles SET commission_rate = ? WHERE discord_id = ?", args: [rate, target.id] });
  const embed = new EmbedBuilder()
    .setTitle("💰 Commission Rate Updated")
    .setColor(COLORS.approved)
    .addFields(
      { name: "Mechanic", value: profile.display_name, inline: true },
      { name: "Old Rate", value: `${(profile.commission_rate * 100).toFixed(0)}%`, inline: true },
      { name: "New Rate", value: `${(rate * 100).toFixed(0)}%`, inline: true },
      { name: "Updated By", value: caller?.display_name ?? interaction.user.username, inline: true }
    )
    .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
  await interaction.editReply({ embeds: [embed] });
  try {
    if (!interaction.guild) return;
    const config = await getGuildConfig(interaction.guild.id);
    if (!config?.log_channel_id) return;
    const ch = await interaction.guild.channels.fetch(config.log_channel_id);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
  } catch { /* ignore */ }
}
