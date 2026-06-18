import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig, nextOrderNumber, getSetting, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, buildJobEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── New order notes ────────────────────────────────────
  if (ns === "order" && action === "notes") {
    await interaction.deferReply({ ephemeral: true });
    const notes = interaction.fields.getTextInputValue("notes");
    const orderId = randomUUID();
    const orderNumber = await nextOrderNumber();
    await db.execute({
      sql: "INSERT INTO orders (id, order_number, mechanic_id, status, items, parts_cost, total, labour, notes) VALUES (?, ?, ?, 'draft', '[]', 0, 0, 0, ?)",
      args: [orderId, orderNumber, interaction.user.id, notes]
    });
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? ["Performance", "Visual & Body", "Tires", "Misc", "Upgrades", "Interior"];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Select a category to add items...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:setpartscost:${orderId}`).setLabel("💰 Set Parts Cost").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("📋 Submit Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
      .setTitle(`📝 Draft Order · ${orderNumber}`).setColor(COLORS.draft)
      .setDescription("Select a category to add items, then submit when ready.")
      .addFields({ name: "Notes", value: notes || "_None_" }, { name: "Items", value: "_No items added yet_" }, { name: "Total", value: "$0" })
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect), buttons]
    });
    return;
  }

  // ── Order reject from modal ────────────────────────────
  if (ns === "order" && action === "rejectmodal") {
    await interaction.deferReply({ ephemeral: true });
    const reason = interaction.fields.getTextInputValue("reason");
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);
    await db.execute({ sql: "UPDATE orders SET status = 'rejected', rejected_reason = ? WHERE id = ?", args: [reason, extra] });
    const ur = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    const updated = rowToOrder(ur.rows[0]);
    const mechanic = await getProfile(order.mechanic_id);
    const embed = buildOrderEmbed(updated, mechanic?.display_name ?? "Unknown");
    if (order.discord_message_id && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.orders_channel_id) { try { const ch = await interaction.guild.channels.fetch(config.orders_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).messages.fetch(order.discord_message_id); await msg.edit({ embeds: [embed], components: [] }); } } catch { /* ignore */ } }
    }
    await interaction.editReply({ content: `❌ Order **${order.order_number}** rejected.`, embeds: [embed] });
    return;
  }

  // ── Parts cost modal ───────────────────────────────────
  if (ns === "order" && action === "partscost") {
    await interaction.deferReply({ ephemeral: true });
    const costStr = interaction.fields.getTextInputValue("cost").replace(/[$,]/g, "");
    const cost = parseFloat(costStr);
    if (isNaN(cost) || cost < 0) { await interaction.editReply({ content: "❌ Invalid cost value." }); return; }
    const r = await db.execute({ sql: "SELECT total FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const total = Number(r.rows[0][0] ?? 0);
    const labour = total - cost;
    await db.execute({ sql: "UPDATE orders SET parts_cost = ?, labour = ? WHERE id = ?", args: [cost, labour, extra] });
    await interaction.editReply({ content: `✅ Parts cost set to **${money(cost)}** · Labour: **${money(labour)}**` });
    return;
  }

  // ── Job posting modal ──────────────────────────────────
  if (ns === "job" && action === "posting") {
    await interaction.deferReply({ ephemeral: true });
    const title = interaction.fields.getTextInputValue("title");
    const body = interaction.fields.getTextInputValue("body");
    const poster = await getProfile(interaction.user.id);
    const jobId = randomUUID();
    const embed = buildJobEmbed(title, body, poster?.display_name ?? interaction.user.username);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`job:apply:${jobId}`).setLabel("📩 Apply").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`job:delete:${jobId}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger)
    );
    let msgId = "";
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.jobs_channel_id) {
        try { const ch = await interaction.guild.channels.fetch(config.jobs_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).send({ embeds: [embed], components: [row] }); msgId = msg.id; } } catch { /* ignore */ }
      }
    }
    await db.execute({ sql: "INSERT INTO jobs (id, posted_by, title, body, discord_message_id) VALUES (?, ?, ?, ?, ?)", args: [jobId, interaction.user.id, title, body, msgId] });
    const jobsCh = interaction.guild ? (await getGuildConfig(interaction.guild.id))?.jobs_channel_id : null;
    await interaction.editReply({
      content: msgId
        ? `✅ Job **${title}** posted${jobsCh ? ` to <#${jobsCh}>` : ""}!`
        : `✅ Job **${title}** saved. Configure a jobs channel with \`/setup jobs-channel\` to post it publicly.`
    });
    return;
  }
}
