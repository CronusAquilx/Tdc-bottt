import { ChatInputCommandInteraction, REST, Routes, SlashCommandBuilder, TextChannel, MessageFlags } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { enableUpdate } from "../lib/featureFlags.js";
import { postOrderPanel } from "../interactions/orderpanel.js";

export const data = new SlashCommandBuilder()
  .setName("implementupdate")
  .setDescription("Publish and activate the staged TDC pay, timeclock, order, and bank update (owner only)");

export async function execute(
  interaction: ChatInputCommandInteraction,
  commands: Array<{ data: { toJSON: () => unknown } }>,
) {
  if (!(await requireRole(interaction, "owner"))) return;
  if (!interaction.guild) {
    await interaction.reply({ content: "Run this command in the shop server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    await interaction.reply({ content: "The bot cannot publish slash commands because its Discord connection is not configured.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rest = new REST().setToken(token);
  let registered: unknown[];
  try {
    const applicationId = Buffer.from(token.split(".")[0], "base64").toString("utf-8");
    registered = await rest.put(
      Routes.applicationGuildCommands(applicationId, interaction.guild.id),
      { body: commands.map(command => command.data.toJSON()) },
    ) as unknown[];
  } catch (error) {
    console.error("[TDC] /implementupdate could not publish Discord commands:", error);
    await interaction.editReply("Update was not activated because Discord rejected the command publish. The old behavior remains enabled; check the bot logs and try again.");
    return;
  }

  try {
    // Activate only after Discord has accepted the complete command set.
    await enableUpdate();
  } catch (error) {
    console.error("[TDC] /implementupdate could not save the activation setting:", error);
    await interaction.editReply("Discord accepted the commands, but the update could not be saved as active. Existing behavior remains enabled; check the bot logs and try again.");
    return;
  }

  let refreshedPanels = 0;
  let failedPanels = 0;
  try {
    const profiles = await db.execute(
      "SELECT discord_id, display_name, sales_channel_id, commission_rate FROM profiles WHERE sales_channel_id IS NOT NULL",
    );
    for (const row of profiles.rows) {
      const memberId = String(row[0] ?? "");
      const displayName = String(row[1] ?? "Mechanic");
      const channelId = String(row[2] ?? "");
      const oldRate = Number(row[3] ?? 0.3);
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) {
        failedPanels++;
        continue;
      }
      try {
        await postOrderPanel(channel as TextChannel, memberId, displayName, oldRate);
        refreshedPanels++;
      } catch (error) {
        failedPanels++;
        console.error(`[TDC] Could not refresh order panel for ${memberId}:`, error);
      }
    }
  } catch (error) {
    failedPanels++;
    console.error("[TDC] Could not load sales panels for update refresh:", error);
  }

  try {
    const config = await getGuildConfig(interaction.guild.id);
    if (config?.bank_account_channel_id) {
      const channel = await interaction.guild.channels.fetch(config.bank_account_channel_id).catch(() => null);
      if (channel?.isTextBased()) {
        const { postBankAccountPanel } = await import("../interactions/bankaccount.js");
        await postBankAccountPanel(channel as TextChannel, interaction.guild.id);
      } else {
        failedPanels++;
      }
    }
  } catch (error) {
    failedPanels++;
    console.error("[TDC] Could not refresh the bank panel:", error);
  }

  await interaction.editReply(
    `Update activated. Discord accepted ${registered.length} slash commands; ${refreshedPanels} sales panels were refreshed.` +
    (failedPanels ? ` ${failedPanels} panel refresh${failedPanels === 1 ? "" : "es"} failed; the features are active, and you can rerun /implementupdate to retry panel refreshes.` : "") +
    " Hourly payroll, 30-minute no-order reminders, own-car orders, and bank controls are enabled.",
  );
}
