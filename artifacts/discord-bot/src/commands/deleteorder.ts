import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { db, getProfile, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("deleteorder")
  .setDescription("Void / remove an order by order number (manager+)")
  .addUserOption(opt =>
    opt.setName("mechanic")
       .setDescription("The mechanic who owns the order")
       .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("orderid")
       .setDescription("Order number, e.g. TDC-0079")
       .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const target     = interaction.options.getUser("mechanic", true);
  const orderInput = interaction.options.getString("orderid", true).trim().toUpperCase();
  const profile    = await getProfile(target.id);

  if (!profile) {
    await interaction.editReply({ content: `❌ No profile found for <@${target.id}>.` });
    return;
  }

  const r = await db.execute({
    sql: "SELECT * FROM orders WHERE mechanic_id = ? AND UPPER(order_number) = ? LIMIT 1",
    args: [target.id, orderInput]
  });

  if (!r.rows.length) {
    await interaction.editReply({
      content: `❌ Order **${orderInput}** not found for **${profile.display_name}**. Make sure you typed the number exactly (e.g. \`TDC-0079\`).`
    });
    return;
  }

  const row = r.rows[0];
  const order = rowToOrder(row);

  if (order.status === "voided") {
    await interaction.editReply({ content: `⚠️ Order **${orderInput}** is already voided.` });
    return;
  }

  const statusLabel: Record<string, string> = {
    draft: "📝 Draft", complete: "✅ Complete", approved: "✅ Approved",
    paid: "💸 Paid", cleared: "🗃️ Cleared"
  };

  const embed = new EmbedBuilder()
    .setTitle(`🗑️  VOID ORDER — ${orderInput}`)
    .setColor(COLORS.warning)
    .setDescription(
      `**Mechanic:** ${profile.display_name}\n` +
      `**Status:** ${statusLabel[order.status] ?? order.status}\n` +
      `**Total:** ${money(order.total)}  ·  **Labour:** ${money(order.labour)}\n\n` +
      `Voiding this order will:\n` +
      `• Remove it from **${profile.display_name}'s commission** total\n` +
      `• Set its status to **Voided** (kept for audit, never deleted)\n\n` +
      `⚠️ This cannot be undone.`
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`deleteorder:confirm:${order.id}:${target.id}`)
      .setLabel(`🗑️  Yes, Void ${orderInput}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("deleteorder:cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row2] });
}
