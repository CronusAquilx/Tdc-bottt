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

// SQL clause to scope queries to since the last payday reset
const SINCE_RESET_SQL =
  `created_at >= COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01')`;

/** Total revenue from completed orders since last payday reset (for draft embed running total) */
async function getWeekRevenue(mechanicId: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND ${SINCE_RESET_SQL}`,
    args: [mechanicId]
  });
  return Number(r.rows[0]?.[0] ?? 0);
}

/** Total commission earned since last payday reset = SUM(labour) × rate */
async function getWeekCommission(mechanicId: string, rate: number): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND ${SINCE_RESET_SQL}`,
    args: [mechanicId]
  });
  return Number(r.rows[0]?.[0] ?? 0) * rate;
}

/** Manager's crew cut this week = their override_rate × total crew commission pool since reset */
async function getManagerCutThisWeek(managerId: string): Promise<number> {
  const profileR = await db.execute({
    sql: "SELECT manager_override_rate FROM profiles WHERE discord_id = ?",
    args: [managerId]
  });
  const overrideRate = Number(profileR.rows[0]?.[0] ?? 0);
  if (!overrideRate) return 0;

  // Total crew commission pool since reset
  const poolR = await db.execute({
    sql: `SELECT o.labour, p.commission_rate
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status = 'complete' AND o.${SINCE_RESET_SQL}`,
    args: []
  });
  const pool = poolR.rows.reduce((s, row) => s + Number(row[0] ?? 0) * Number(row[1] ?? 0.3), 0);
  return pool * overrideRate;
}

// ─── Shared button row builders ───────────────────────────────────────────────

function mainDraftButtonRows(orderId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Labour").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`order:maxperf:${orderId}`).setLabel("⚡ Max Performance").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:extras:${orderId}`).setLabel("🩸 Body Parts").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:removeitems:${orderId}`).setLabel("🗑️ Remove").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
    )
  ];
}

function categoryViewButtonRow(orderId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`order:backtocats:${orderId}`).setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Labour").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
  );
}

export { mainDraftButtonRows, categoryViewButtonRow };

export async function handleDraftButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const orderId = rest.join(":");

  // ── "Create New Order" button from pinned panel ────────────────────────────
  if (ns === "order" && action === "newpanel") {
    if (!(await requireRole(interaction, "mechanic"))) return true;

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

    const guildId = interaction.guildId ?? "";
    await db.execute({
      sql: "INSERT INTO orders (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes) VALUES (?, ?, ?, ?, 'draft', '[]', 0, 0, 0, '')",
      args: [newOrderId, orderNumber, interaction.user.id, guildId]
    });

    const [catalogStr, weekRevenue, draft] = await Promise.all([
      getSetting("parts_catalog"),
      getWeekRevenue(interaction.user.id),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [newOrderId] }).then(r => rowToOrder(r.rows[0]))
    ]);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${newOrderId}`)
      .setPlaceholder("Pick a service category...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(draft, weekRevenue)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(newOrderId)
      ]
    });
    return true;
  }

  if (ns !== "order") return false;

  // ── Back to categories ──────────────────────────────────────────────────────
  if (action === "backtocats") {
    await interaction.deferUpdate();
    const [catalogStr, r, weekRevenue] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] }),
      getWeekRevenue(interaction.user.id)
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
      embeds: [buildDraftEmbed(order, weekRevenue)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return true;
  }

  // ── Remove Items — show current order items as a select ────────────────────
  if (action === "removeitems") {
    await interaction.deferReply({ ephemeral: true });
    const r = await db.execute({ sql: "SELECT items FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const items: any[] = JSON.parse(String(r.rows[0][0] ?? "[]"));
    if (!items.length) {
      await interaction.editReply({ content: "ℹ️ No items on this order to remove." });
      return true;
    }

    const removeSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:removeitem:${orderId}`)
      .setPlaceholder("Select items to remove...")
      .setMinValues(1)
      .setMaxValues(Math.min(items.length, 10))
      .addOptions(items.map((item: any, idx: number) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${item.label} (${item.category})`)
          .setValue(String(idx))
          .setDescription(`${money(item.price)}`)
      ));

    await interaction.editReply({
      content: "Select which items to remove from the order:",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeSelect)]
    });
    return true;
  }

  // ── Max Performance modal ───────────────────────────────────────────────────
  if (action === "maxperf") {
    const modal = new ModalBuilder()
      .setCustomId(`order:addmaxperf:${orderId}`)
      .setTitle("⚡ Max Performance Package");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Total price (e.g. 100000)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Enter Max Performance total price...")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // ── Body Parts modal ────────────────────────────────────────────────────────
  if (action === "extras") {
    const modal = new ModalBuilder()
      .setCustomId(`order:addextras:${orderId}`)
      .setTitle("🩸 Add Body Parts");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel("How many body parts? (each = $500)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 3")
      )
    );
    await interaction.showModal(modal);
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

    const [ur, profile] = await Promise.all([
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] }),
      getProfile(interaction.user.id)
    ]);
    const completed = rowToOrder(ur.rows[0]);
    const rate = profile?.commission_rate ?? 0.3;

    const [weekCommission, managerCut] = await Promise.all([
      getWeekCommission(interaction.user.id, rate),
      getManagerCutThisWeek(interaction.user.id)
    ]);

    const embed = buildOrderEmbed(completed, profile?.display_name ?? "Unknown", weekCommission, rate, managerCut);

    const mechanicId = interaction.user.id;

    const newOrderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("order:newpanel")
        .setLabel("📋  New Order")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("clockout:panel")
        .setLabel("🔴  Clock Out")
        .setStyle(ButtonStyle.Danger)
    );

    const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`orderpay:start:${mechanicId}`)
        .setLabel("💸  Pay")
        .setStyle(ButtonStyle.Primary)
    );

    let postedTo = "";
    if (interaction.guild && profile?.sales_channel_id) {
      try {
        const ch = await interaction.guild.channels.fetch(profile.sales_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).send({ embeds: [embed], components: [newOrderRow, payRow] });
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
