import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("loa")
  .setDescription("Submit a Leave of Absence request");

export async function execute(interaction: ChatInputCommandInteraction) {
  const modal = new ModalBuilder().setCustomId("loa:submit").setTitle("Leave of Absence Request");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for LOA")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
        .setPlaceholder("Personal reasons, vacation, school, etc...")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("start_date")
        .setLabel("Start Date (e.g. 2026-07-01)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("YYYY-MM-DD")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("return_date")
        .setLabel("Expected Return Date (e.g. 2026-07-15)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("YYYY-MM-DD")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Additional Notes (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(300)
        .setPlaceholder("Anything else the team should know...")
    )
  );
  await interaction.showModal(modal);
}
