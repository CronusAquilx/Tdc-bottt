import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("pay")
  .setDescription("Process weekly payout for a mechanic (owner only)")
  .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("mechanic", true);
  const profile = await getProfile(target.id);
  if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }

  const ws = weekStart();
  const r = await db.execute({
    sql: "SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND DATE(created_at) >= ?",
    args: [target.id, ws]
  });
  if (!r.rows.length) {
    await interaction.editReply({ content: `❌ No completed orders for **${profile.display_name}** this week.` });
    return;
  }

  const totalLabour = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
  const totalRevenue = r.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
  const commission = totalLabour * profile.commission_rate;

  const confirmEmbed = new EmbedBuilder()
    .setTitle(`💸  Confirm Payout  ·  ${profile.display_name}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Orders to Pay", value: String(r.rows.length), inline: true },
      { name: "Total Revenue", value: money(totalRevenue), inline: true },
      { name: "Total Labour", value: money(totalLabour), inline: true },
      { name: `Commission (${(profile.commission_rate * 100).toFixed(0)}%)`, value: `**${money(commission)}**`, inline: false }
    )
    .setDescription("Click **Confirm** to process this payout and mark all orders as paid.")
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pay:confirm:${target.id}`).setLabel("✅ Confirm Payout").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pay:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({ embeds: [confirmEmbed], components: [row] });
}
