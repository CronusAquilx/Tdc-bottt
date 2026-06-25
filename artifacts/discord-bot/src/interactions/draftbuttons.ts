import {
  ButtonInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { db, getProfile, getSetting, rowToOrder, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, buildDraftEmbed, buildClockInPromptEmbed, buildClockInEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

async function getAllTimeTotal(mechanicId: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete'",
    args: [mechanicId]
  });
  return Number(r.rows[0]?.[0] ?? 0);
}

export async function handleDraftButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const orderId = rest.join(":");

  // ── "Create New Order" button from pinned panel ────────────────────────────
  if (ns === "order" && action === "newpanel") {
    if (!(await requireRole(interaction, "mechanic"))) return true;

    // Check the mechanic is clocked in
    const active = await db.execute({
      sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
      args: [interaction.user.id]
    });

    if (!active.rows[0]) {
      const promptEmbed = buildClockInPromptEmbed();
      const clockRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("clockin:panel").setLabel("🟢  Clock In Now").setStyle(ButtonStyle.Success)
      );
      await interaction.reply({ embeds: [promptEmbed], components: [clockRow], ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const newOrderId = randomUUID();
    const { nextOrderNumber } = await import("../db.js");
    const orderNumber = await nextOrderNumber();

    await db.execute({
      sql: "INSERT INTO orders (id, order_number, mechanic_id, status, items, parts_cost, total, labour, notes) VALUES (?, ?, ?, 'draft', '[]', 0, 0, 0, '')",
      args: [newOrderId, orderNumber, interaction.user.id]
    });

    const [catalogStr, allTimeTotal, draft] = await Promise.all([
      getSetting("parts_catalog"),
      getAllTimeTotal(interaction.user.id),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [newOrderId] }).then(r => rowToOrder(r.rows[0]))
    ]);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${newOrderId}`)
      .setPlaceholder("Pick a service category...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(draft, allTimeTotal)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        draftButtons(newOrderId)
      ]
    });
    return true;
  }

  if (ns !== "order") return false;

  // ── Back to categories ──────────────────────────────────────────────────────
  if (action === "backtocats") {
    await interaction.deferUpdate();
    const [catalogStr, r, allTimeTotal] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] }),
      getAllTimeTotal(interaction.user.id)
    ]);
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(order, allTimeTotal)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        draftButtons(orderId)
      ]
    });
    return true;
  }

  // ── Edit Labour modal ───────────────────────────────────────────────────────
  if (action === "editlabour") {
    const r = await db.execute({ sql: "SELECT labour FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const currentLabour = Number(r.rows[0][0] ?? 0);
    const modal = new ModalBuilder().setCustomId(`order:setlabour:${orderId}`).setTitle("Edit Labour Amount");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("labour")
        .setLabel("Labour amount (e.g. 15000)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(currentLabour))
        .setPlaceholder("Enter custom labour amount...")
    ));
    await interaction.showModal(modal);
    return true;
  }

  // ── Complete Order ──────────────────────────────────────────────────────────
  if (action === "submit") {
    if (!(await requireRole(interaction, "mechanic"))) return true;
    await interaction.deferUpdate();

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);

    if (!order.items.length) {
      await interaction.followUp({ content: "❌ Add at least one service before completing the order.", ephemeral: true });
      return true;
    }

    await db.execute({
      sql: "UPDATE orders SET status = 'complete', completed_at = datetime('now') WHERE id = ?",
      args: [orderId]
    });

    const [ur, profile, allTimeTotal] = await Promise.all([
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] }),
      getProfile(interaction.user.id),
      getAllTimeTotal(interaction.user.id)
    ]);
    const completed = rowToOrder(ur.rows[0]);

    // allTimeTotal from DB now includes this completed order
    const embed = buildOrderEmbed(completed, profile?.display_name ?? "Unknown", allTimeTotal, profile?.commission_rate ?? 0.3);

    const newOrderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("order:newpanel")
        .setLabel("📋  New Order")
        .setStyle(ButtonStyle.Success)
    );

    let postedTo = "";
    if (interaction.guild && profile?.sales_channel_id) {
      try {
        const ch = await interaction.guild.channels.fetch(profile.sales_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).send({ embeds: [embed], components: [newOrderRow] });
          postedTo = profile.sales_channel_id;
          await db.execute({ sql: "UPDATE orders SET discord_message_id = ? WHERE id = ?", args: [msg.id, orderId] });
        }
      } catch { /* ignore */ }
    }

    await interaction.editReply({
      content: postedTo
        ? `✅ **${completed.order_number}** complete! Posted to <#${postedTo}>`
        : `✅ **${completed.order_number}** complete!\n*Set up a sales channel to auto-post orders.*`,
      embeds: [embed],
      components: []
    });
    return true;
  }

  // ── Cancel ──────────────────────────────────────────────────────────────────
  if (action === "cancel") {
    await interaction.deferUpdate();
    await db.execute({ sql: "DELETE FROM orders WHERE id = ?", args: [orderId] });
    await interaction.editReply({ content: "❌ Order cancelled.", embeds: [], components: [] });
    return true;
  }

  return false;
}

function draftButtons(orderId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
  );
}
