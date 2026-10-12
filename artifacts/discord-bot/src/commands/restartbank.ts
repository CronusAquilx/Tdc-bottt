import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { requireRole } from "../lib/roles.js";
import { money } from "../lib/embeds.js";
import { resetBankBaseline } from "../interactions/bankaccount.js";
import { isUpdateEnabled } from "../lib/featureFlags.js";

export const data = new SlashCommandBuilder()
  .setName("restartbank")
  .setDescription("Start a new bank-tracking baseline without deleting past logs (manager+)")
  .addNumberOption(option =>
    option.setName("amount").setDescription("Current balance to use as the new baseline").setRequired(true).setMinValue(0)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  if (!(await isUpdateEnabled())) {
    await interaction.reply({ content: "The staged update has not been activated yet.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.guild) {
    await interaction.reply({ content: "This command only works in the shop server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const amount = interaction.options.getNumber("amount", true);
  await resetBankBaseline(interaction.guild.id, amount, interaction.user.id);
  await interaction.reply({
    content: `Bank tracking restarted from ${money(amount)}. Earlier bank logs are preserved.`,
    flags: MessageFlags.Ephemeral,
  });
}
