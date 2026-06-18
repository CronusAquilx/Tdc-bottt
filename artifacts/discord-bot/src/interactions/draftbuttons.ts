import {
  ButtonInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { db, getProfile, getGuildConfig, getSetting, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, COLORS, money } from "../lib/embeds.js";

export async function handleDraftButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const orderId = rest.join(":");
  if (ns !== "order") return false;

  if (action === "backtocats") {
    await interaction.deferUpdate();
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Select a category to add items...")
      .addOptions(categories.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));
    const embed = new EmbedBuilder()
      .setTitle(`📝 Draft · ${order.order_number}`).setColor(COLORS.draft)
      .addFields(
        { name: `Items (${order.items.length})`, value: order.items.map((i: any) => `• ${i.label} — ${money(i.price)}`).join("\n") || "_None_" },
        { name: "Total", value: money(order.total), inline: true },
        { name: "Parts Cost", value: money(order.parts_cost), inline: true },
        { name: "Labour", value: money(order.labour), inline: true }
      ).setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:setpartscost:${orderId}`).setLabel("💰 Set Parts Cost").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("📋 Submit Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return true;
  }

  if (action === "setpartscost") {
    const modal = new ModalBuilder().setCustomId(`order:partscost:${orderId}`).setTitle("Set Parts Cost");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("cost").setLabel("Parts cost amount (e.g. 5000)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("0")
    ));
    await interaction.showModal(modal);
    return true;
  }

  if (action === "submit") {
    if (!(await requireRole(interaction, "mechanic"))) return true;
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);
    if (!order.items.length) { await interaction.followUp({ content: "❌ Add at least one item before submitting.", ephemeral: true }); return true; }
    await db.execute({ sql: "UPDATE orders SET status = 'submitted' WHERE id = ?", args: [orderId] });
    const ur = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    const submitted = rowToOrder(ur.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const embed = buildOrderEmbed(submitted, profile?.display_name ?? "Unknown");
    const approveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:approve:${orderId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:rejectprompt:${orderId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
    );
    let msgId = "";
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.orders_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.orders_channel_id);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({ embeds: [embed], components: [approveRow] });
            msgId = msg.id;
            await db.execute({ sql: "UPDATE orders SET discord_message_id = ? WHERE id = ?", args: [msg.id, orderId] });
          }
        } catch { /* ignore */ }
      }
    }
    await interaction.editReply({
      content: msgId ? `✅ Order **${submitted.order_number}** submitted to orders channel!` : `✅ Order **${submitted.order_number}** submitted! Configure an orders channel with \`/setup orders-channel\`.`,
      embeds: [embed], components: []
    });
    return true;
  }

  if (action === "cancel") {
    await interaction.deferUpdate();
    await db.execute({ sql: "DELETE FROM orders WHERE id = ?", args: [orderId] });
    await interaction.editReply({ content: "❌ Order cancelled.", embeds: [], components: [] });
    return true;
  }

  return false;
}
