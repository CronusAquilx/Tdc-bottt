import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { postOrderPanel } from "../interactions/orderpanel.js";

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
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

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

  if (commission !== null) {
    updates.push("commission_adjustment = ?");
    args.push(commission);
  }
  if (managerCut !== null) {
    updates.push("manager_cut_adjustment = ?");
    args.push(managerCut);
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

  // Re-post their order panel in their sales channel so it reflects the new rate
  if (interaction.guild && updatedProfile?.sales_channel_id) {
    try {
      const ch = await interaction.guild.channels.fetch(updatedProfile.sales_channel_id).catch(() => null);
      if (ch?.isTextBased()) {
        const noticeLines: string[] = [];
        if (commission !== null)     noticeLines.push(`💵 Weekly commission manually set to **${money(commission)}**`);
        if (managerCut !== null)     noticeLines.push(`👔 Manager cut manually set to **${money(managerCut)}**`);
        if (commissionRate !== null) noticeLines.push(`📊 Commission rate updated to **${(commissionRate * 100).toFixed(0)}%**`);

        await (ch as any).send({
          content:
            `📢 **Pay Update for ${profile.display_name}**\n` +
            noticeLines.map(l => `> ${l}`).join("\n") +
            `\n> *Updated by <@${interaction.user.id}>*`
        });

        // Also re-post a fresh order panel if commission rate changed
        if (commissionRate !== null) {
          await postOrderPanel(
            ch as any,
            target.id,
            updatedProfile.display_name,
            commissionRate
          );
        }
      }
    } catch { /* ignore */ }
  }

  // Log to log channel
  try {
    if (!interaction.guild) return;
    const config = await getGuildConfig(interaction.guild.id);
    if (!config?.log_channel_id) return;
    const ch = await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
  } catch { /* ignore */ }
}
