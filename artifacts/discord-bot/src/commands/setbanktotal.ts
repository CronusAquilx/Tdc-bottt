import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags, TextChannel } from "discord.js";
import { getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { recordBankBalance, buildBankLogEmbed, buildBankPaidComponents } from "../interactions/bankaccount.js";
import { money } from "../lib/embeds.js";
import { isUpdateEnabled } from "../lib/featureFlags.js";

export const data = new SlashCommandBuilder()
  .setName("setbanktotal")
  .setDescription("Record the current shop bank balance (manager+)")
  .addNumberOption(option =>
    option.setName("amount").setDescription("Current bank balance").setRequired(true).setMinValue(0)
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const amount = interaction.options.getNumber("amount", true);
  const comparison = await recordBankBalance(interaction.guild.id, amount, interaction.user.id);
  const config = await getGuildConfig(interaction.guild.id);
  const channel = config?.bank_account_channel_id
    ? await interaction.guild.channels.fetch(config.bank_account_channel_id).catch(() => null)
    : null;
  if (channel?.isTextBased()) {
    await (channel as TextChannel).send({
      embeds: [buildBankLogEmbed(comparison)],
      components: buildBankPaidComponents(),
    });
  }
  await interaction.editReply({
    content: `Bank total saved as ${money(amount)}.${comparison.shortfall > 0 ? ` It is ${money(comparison.shortfall)} under expected.` : comparison.surplus > 0 ? ` It is ${money(comparison.surplus)} over expected.` : ""}`,
  });
}
