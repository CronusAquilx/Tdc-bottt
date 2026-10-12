import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
, MessageFlags} from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";
import { isUpdateEnabled } from "../lib/featureFlags.js";
import { payrollRateForRole, resolveTdcRole } from "../lib/payrollPolicy.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("pay")
  .setDescription("Process weekly payout for a mechanic (owner only)")
  .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const target = interaction.options.getUser("mechanic", true);
  const profile = await getProfile(target.id);
  if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }

  const ws = weekStart();
  const SINCE_RESET = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const r = await db.execute({
    sql: `SELECT total, parts_cost, labour, COALESCE(is_own_car, 0) FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved') AND ${SINCE_RESET}`,
    args: [target.id]
  });
  if (!r.rows.length) {
    await interaction.editReply({ content: `❌ No completed orders for **${profile.display_name}** this pay period.` });
    return;
  }

  const totalLabour  = r.rows.reduce((s, row) => s + (Number(row[3] ?? 0) === 1 ? 0 : Number(row[2] ?? 0)), 0);
  const totalRevenue = r.rows.reduce((s, row) => s + Number(row[0] ?? 0), 0);
  const updateEnabled = await isUpdateEnabled();
  const commissionRate = updateEnabled
    ? payrollRateForRole(await resolveTdcRole(interaction.guild ?? undefined, target.id)).commissionRate
    : profile.commission_rate;
  // Snapshot-aware commission — matches /setpay + /payall formula
  const commAdj     = profile.commission_adjustment ?? 0;
  const snapshot    = profile.commission_labour_snapshot ?? 0;
  const labourAfter = Math.max(0, totalLabour - snapshot);
  const commission  = commAdj > 0
    ? commAdj + labourAfter * commissionRate
    : totalLabour * commissionRate;
  const rateLabel = commAdj > 0
    ? `set ${Math.round(commAdj).toLocaleString()} + new orders`
    : `${(commissionRate * 100).toFixed(0)}%`;

  const confirmEmbed = new EmbedBuilder()
    .setTitle(`💸  Confirm Payout  ·  ${profile.display_name}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Orders to Pay", value: String(r.rows.length), inline: true },
      { name: "Total Revenue", value: money(totalRevenue), inline: true },
      { name: "Total Labour", value: money(totalLabour), inline: true },
      { name: `Commission (${rateLabel})`, value: `**${money(commission)}**`, inline: false }
    )
    .setDescription("Click **Confirm** to process this payout and mark all orders as paid.")
    .setFooter({ text: FOOTER });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pay:confirm:${target.id}`).setLabel("✅ Confirm Payout").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pay:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({ embeds: [confirmEmbed], components: [row] });
}
