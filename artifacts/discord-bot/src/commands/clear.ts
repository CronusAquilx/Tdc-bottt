import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Clear week stats without paying (manager+)")
  .addSubcommand(sub =>
    sub.setName("all")
       .setDescription("Clear ALL mechanics' week orders — resets every commission total to $0")
  )
  .addSubcommand(sub =>
    sub.setName("player")
       .setDescription("Clear a specific mechanic's week orders only")
       .addUserOption(opt =>
         opt.setName("user")
            .setDescription("Mechanic to clear")
            .setRequired(true)
       )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === "all") {
    const embed = new EmbedBuilder()
      .setTitle("🗑️  CLEAR ALL — Are you sure?")
      .setColor(COLORS.warning)
      .setDescription(
        "This will clear **ALL mechanics'** completed orders for this week.\n\n" +
        "**After clearing:**\n" +
        "• Orders ➜ **0**\n" +
        "• Revenue ➜ **$0**\n" +
        "• Commissions ➜ **$0**\n" +
        "• Hours ➜ reset to **0**\n\n" +
        "⚠️ *Orders are archived, not deleted. This cannot be undone.*"
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("clear:confirm:all").setLabel("🗑️ Yes, Clear All").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("clear:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (sub === "player") {
    const target = interaction.options.getUser("user", true);
    const profile = await getProfile(target.id);
    const displayName = profile?.display_name ?? target.username;

    const embed = new EmbedBuilder()
      .setTitle("🗑️  CLEAR PLAYER — Are you sure?")
      .setColor(COLORS.warning)
      .setDescription(
        `This will clear **${displayName}**'s completed orders for this week.\n\n` +
        "**After clearing:**\n" +
        "• Orders ➜ **0**\n" +
        "• Revenue ➜ **$0**\n" +
        "• Commission ➜ **$0**\n" +
        "• Hours ➜ reset to **0**\n\n" +
        "⚠️ *Orders are archived, not deleted. Other mechanics' stats are unchanged.*"
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`clear:confirm:player:${target.id}`)
        .setLabel(`🗑️ Yes, Clear ${displayName}`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("clear:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }
}
