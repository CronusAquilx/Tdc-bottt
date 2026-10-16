import {
  SlashCommandBuilder, ChatInputCommandInteraction, ButtonInteraction, EmbedBuilder, MessageFlags,
} from "discord.js";
import { requireRole } from "../lib/roles.js";
import { refreshAllSalesPanels } from "../lib/saleschannel.js";
import { logEvent } from "../lib/eventLog.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("refreshallpanels")
  .setDescription("Resend a fresh sales panel to every sales channel, replacing the old one (manager+)");

/** Shared by the slash command and the Admin Panel "Refresh Panels" button. */
export async function runRefreshAllPanels(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ This must be used in the shop server." });
    return;
  }

  await interaction.editReply({ content: "🔄 Resending sales panels to every sales channel… this can take a minute." });
  const result = await refreshAllSalesPanels(guild);

  logEvent({
    kind: "panels_refreshed",
    guildId: guild.id,
    userId: interaction.user.id,
    userName: interaction.user.username,
    detail: `${result.refreshed}/${result.total} sales panels resent${result.failed.length ? `, ${result.failed.length} failed` : ""}`,
  });

  const embed = new EmbedBuilder()
    .setTitle("🔄  Sales Panels Refreshed")
    .setColor(result.failed.length ? COLORS.warning : COLORS.approved)
    .setDescription(
      `✅ Fresh panel sent to **${result.refreshed}** of **${result.total}** sales channel(s). ` +
      "Old panels were removed and the new one is pinned." +
      (result.failed.length
        ? `\n\n⚠️ **${result.failed.length}** failed:\n${result.failed.slice(0, 15).map(f => `• ${f}`).join("\n")}`
        : "")
    )
    .setTimestamp();
  await interaction.editReply({ content: "", embeds: [embed] });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await runRefreshAllPanels(interaction);
}
