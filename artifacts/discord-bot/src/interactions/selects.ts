import {
  AnySelectMenuInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getSetting, rowToOrder, setGuildRoleMapping, getGuildConfig } from "../db.js";
import { COLORS, money } from "../lib/embeds.js";

export async function handleSelect(interaction: AnySelectMenuInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── Role select menus (setup:setrole:level) ────────────
  if (interaction.isRoleSelectMenu()) {
    if (ns === "setup" && action === "setrole") {
      const level = rest[0] as "owner" | "manager" | "trainer" | "mechanic";
      const validLevels = ["owner", "manager", "trainer", "mechanic"];
      if (!validLevels.includes(level)) { await interaction.reply({ content: "❌ Invalid role level.", ephemeral: true }); return; }
      const roleId = interaction.values[0];
      if (!interaction.guild) { await interaction.reply({ content: "❌ Must be used in a server.", ephemeral: true }); return; }
      await setGuildRoleMapping(interaction.guild.id, level, roleId);
      const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
      await interaction.reply({ content: `✅ **${levelLabel}** permission level mapped to <@&${roleId}>. Members with that role can now use ${level}-level commands.`, ephemeral: true });
    }
    return;
  }

  if (!interaction.isStringSelectMenu()) return;

  // ── Select category → show items ──────────────────────
  if (ns === "order" && action === "selectcategory") {
    await interaction.deferUpdate();
    const category = interaction.values[0];
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const items: { label: string; category: string; price: number; cost: number }[] = catalog.items ?? [];
    const catItems = items.filter(i => i.category === category);
    if (!catItems.length) { await interaction.followUp({ content: `No items in **${category}**.`, ephemeral: true }); return; }

    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectitem:${extra}:${category}`)
      .setPlaceholder(`Pick items from ${category}...`)
      .setMinValues(1).setMaxValues(Math.min(catItems.length, 10))
      .addOptions(catItems.map(i =>
        new StringSelectMenuOptionBuilder().setLabel(i.label).setValue(i.label).setDescription(`${money(i.price)} (cost: ${money(i.cost)})`)
      ));

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    const order = r.rows[0] ? rowToOrder(r.rows[0]) : null;
    const currentItems = order?.items ?? [];

    const embed = new EmbedBuilder()
      .setTitle(`📝 Draft · ${order?.order_number ?? "—"} — ${category}`).setColor(COLORS.draft)
      .setDescription("Select items to add:")
      .addFields(
        { name: "Current Items", value: currentItems.length ? currentItems.map((i: any) => `• ${i.label} — ${money(i.price)}`).join("\n") : "_None yet_" },
        { name: "Total So Far", value: money(order?.total ?? 0) }
      )
      .setFooter({ text: "Tokyo Drift Customs" });

    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:backtocats:${extra}`).setLabel("← Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:setpartscost:${extra}`).setLabel("💰 Set Parts Cost").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${extra}`).setLabel("📋 Submit Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${extra}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return;
  }

  // ── Select specific items ──────────────────────────────
  if (ns === "order" && action === "selectitem") {
    await interaction.deferUpdate();
    const orderId = extra.split(":")[0];
    const category = extra.split(":").slice(1).join(":");
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const allItems: { label: string; category: string; price: number; cost: number }[] = catalog.items ?? [];
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const currentItems: any[] = order.items ?? [];
    const newItems = interaction.values.map(label => {
      const found = allItems.find(i => i.label === label && i.category === category);
      return found ? { label: found.label, price: found.price, cost: found.cost, category: found.category } : null;
    }).filter(Boolean);
    const merged = [...currentItems, ...newItems];
    const newTotal = merged.reduce((s: number, i: any) => s + i.price, 0);
    const newLabour = newTotal - order.parts_cost;
    await db.execute({ sql: "UPDATE orders SET items = ?, total = ?, labour = ? WHERE id = ?", args: [JSON.stringify(merged), newTotal, newLabour, orderId] });
    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more items by category...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));
    const embed = new EmbedBuilder()
      .setTitle(`📝 Draft · ${order.order_number}`).setColor(COLORS.draft)
      .addFields(
        { name: `Items (${merged.length})`, value: merged.map((i: any) => `• **[${i.category}]** ${i.label} — ${money(i.price)}`).join("\n").slice(0, 1024) || "_None_" },
        { name: "Total", value: money(newTotal), inline: true },
        { name: "Parts Cost", value: money(order.parts_cost), inline: true },
        { name: "Labour", value: money(newLabour), inline: true },
        { name: "Notes", value: order.notes || "_None_" }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
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
    return;
  }
}
