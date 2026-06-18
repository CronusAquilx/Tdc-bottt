import {
  AnySelectMenuInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} from "discord.js";
import { db, getProfile, getSetting, rowToOrder, setGuildRoleMapping } from "../db.js";
import { buildDraftEmbed, money } from "../lib/embeds.js";

export async function handleSelect(interaction: AnySelectMenuInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── Role select menus (setup:setrole:level) ────────────────────────────────
  if (interaction.isRoleSelectMenu()) {
    if (ns === "setup" && action === "setrole") {
      const level = rest[0] as "owner" | "manager" | "trainer" | "mechanic";
      const validLevels = ["owner", "manager", "trainer", "mechanic"];
      if (!validLevels.includes(level)) { await interaction.reply({ content: "❌ Invalid role level.", ephemeral: true }); return; }
      const roleId = interaction.values[0];
      if (!interaction.guild) { await interaction.reply({ content: "❌ Must be used in a server.", ephemeral: true }); return; }
      await setGuildRoleMapping(interaction.guild.id, level, roleId);
      const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
      await interaction.reply({ content: `✅ **${levelLabel}** mapped to <@&${roleId}>. Members with this role can now use ${level}-level commands.`, ephemeral: true });
    }
    return;
  }

  if (!interaction.isStringSelectMenu()) return;

  // ── Select category → show items ───────────────────────────────────────────
  if (ns === "order" && action === "selectcategory") {
    await interaction.deferUpdate();
    const category = interaction.values[0];
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const items: { label: string; category: string; price: number; cost: number; labour: number }[] = catalog.items ?? [];
    const catItems = items.filter(i => i.category === category);
    if (!catItems.length) { await interaction.followUp({ content: `No items in **${category}**.`, ephemeral: true }); return; }

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const rate = profile?.commission_rate ?? 0.3;

    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectitem:${extra}:${category}`)
      .setPlaceholder(`Select from ${category}...`)
      .setMinValues(1)
      .setMaxValues(Math.min(catItems.length, 10))
      .addOptions(catItems.map(i =>
        new StringSelectMenuOptionBuilder()
          .setLabel(i.label)
          .setValue(i.label)
          .setDescription(`Parts: ${money(i.cost)} | Labour: ${money(i.labour)} | Total: ${money(i.price)}`)
      ));

    const embed = buildDraftEmbed(order, rate);
    embed.setTitle(`📝  DRAFT  ·  ${order.order_number}  ·  ${category}`);

    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:backtocats:${extra}`).setLabel("← Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:editlabour:${extra}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${extra}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${extra}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return;
  }

  // ── Select specific items ──────────────────────────────────────────────────
  if (ns === "order" && action === "selectitem") {
    await interaction.deferUpdate();
    const orderId = extra.split(":")[0];
    const category = extra.split(":").slice(1).join(":");
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const allItems: { label: string; category: string; price: number; cost: number; labour: number }[] = catalog.items ?? [];
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const currentItems: any[] = order.items ?? [];

    // Map selected labels to catalog items, skipping any already on the order
    const existingKeys = new Set(currentItems.map((i: any) => `${i.category}::${i.label}`));
    const newItems = interaction.values.map(label => {
      const found = allItems.find(i => i.label === label && i.category === category);
      if (!found) return null;
      const key = `${found.category}::${found.label}`;
      if (existingKeys.has(key)) return null;
      existingKeys.add(key);
      return { label: found.label, price: found.price, cost: found.cost, labour: found.labour, category: found.category };
    }).filter(Boolean);

    if (!newItems.length) {
      await interaction.followUp({ content: "⚠️ All selected items are already on this order.", ephemeral: true });
    }

    const merged = [...currentItems, ...newItems];

    // Auto-calculate from catalog data
    const newPartsCost = merged.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour = merged.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal = merged.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(merged), newPartsCost, newLabour, newTotal, orderId]
    });

    const updated = rowToOrder((await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })).rows[0]);
    const profile = await getProfile(interaction.user.id);
    const rate = profile?.commission_rate ?? 0.3;

    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, rate)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return;
  }
}
