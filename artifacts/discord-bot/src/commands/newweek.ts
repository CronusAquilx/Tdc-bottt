import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
, MessageFlags} from "discord.js";
import { db } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("newweek")
  .setDescription("Send the NEW WEEK message to all sales channels (manager+)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setTitle("📅  Send NEW WEEK Message")
    .setColor(COLORS.primary)
    .setDescription(
      "This will post the **NEW WEEK** message to every mechanic's sales channel.\n\n" +
      "It will look like:\n" +
      "```\n" +
      "🗓️  NEW WEEK — LET'S GET IT!\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "> 💪 Fresh start. New money. New orders.\n" +
      "> 🏁 Clock in and get grinding!\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "```"
    )
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("newweek:confirm").setLabel("📅 Send to All Sales Channels").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("newweek:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
