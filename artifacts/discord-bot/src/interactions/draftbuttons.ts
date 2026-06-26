import {
  ButtonInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { db, getProfile, getSetting, rowToOrder, getGuildConfig } from "../db.js";
import { requireRole, detectUserRoleLevel } from "../lib/roles.js";
import { buildOrderEmbed, buildDraftEmbed, buildClockInPromptEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

const SINCE_RESET_SQL =
  `created_at >= COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01')`;

const DONE_STATUSES = `status IN ('complete', 'approved', 'paid')`;

/**
 * Central commission helper — call once per view refresh.
 * roleLevel: 'mechanic' | 'trainer' | 'manager' | 'owner'
 */
export async function getCommissionData(userId: string, guildId: string, roleLevel: string) {
  const [profile, config] = await Promise.all([
    getProfile(userId),
    getGuildConfig(guildId)
  ]);
  const rate = profile?.commission_rate ?? 0.3;

  const weekLabourR = await db.execute({
    sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE mechanic_id = ? AND ${DONE_STATUSES} AND ${SINCE_RESET_SQL}`,
    args: [userId]
  });
  const weekCommission = Number(weekLabourR.rows[0]?.[0] ?? 0) * rate;

  let crewCut = 0;
  let crewCutRate = 0;
  let crewCutLabel = "";

  if (roleLevel === "trainer") {
    crewCutRate = config?.trainer_crew_rate ?? 0.10;
    const r = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE ${DONE_STATUSES} AND ${SINCE_RESET_SQL} AND mechanic_id != ? AND role_level = 'mechanic'`,
      args: [userId]
    });
    crewCut = Number(r.rows[0]?.[0] ?? 0) * crewCutRate;
    crewCutLabel = "Trainer Cut";
  } else if (roleLevel === "manager" || roleLevel === "owner") {
    crewCutRate = config?.manager_crew_rate ?? 0.20;
    const r = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE ${DONE_STATUSES} AND ${SINCE_RESET_SQL} AND mechanic_id != ? AND role_level IN ('mechanic', 'trainer')`,
      args: [userId]
    });
    crewCut = Number(r.rows[0]?.[0] ?? 0) * crewCutRate;
    crewCutLabel = "Manager Cut";
  }

  return { rate, weekCommission, crewCut, crewCutRate, crewCutLabel };
}

// ─── Shared button row builders ───────────────────────────────────────────────

function mainDraftButtonRows(orderId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Labour").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`order:maxperf:${orderId}`).setLabel("⚡ Max Perf").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:fullpackage:${orderId}`).setLabel("📦 Full Build").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:extras:${orderId}`).setLabel("🩸 Body Parts").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`order:removeitems:${orderId}`).setLabel("🗑️ Remove").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:discount:${orderId}`).setLabel("💲 Discount").setStyle(ButtonStyle.Secondary),
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
    await interaction.deferReply({ ephemeral: true });

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
      await interaction.editReply({ embeds: [promptEmbed], components: [clockRow] });
      return true;
    }

    const newOrderId = randomUUID();
    const { nextOrderNumber } = await import("../db.js");
    const orderNumber = await nextOrderNumber();
    const guildId = interaction.guildId ?? "";

    // Detect and store the user's role level on the order
    const roleLevel = await detectUserRoleLevel(interaction);

    await db.execute({
      sql: "INSERT INTO orders (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes, role_level) VALUES (?, ?, ?, ?, 'draft', '[]', 0, 0, 0, '', ?)",
      args: [newOrderId, orderNumber, interaction.user.id, guildId, roleLevel]
    });

    const [catalogStr, draft] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [newOrderId] }).then(r => rowToOrder(r.rows[0]))
    ]);
    const commData = await getCommissionData(interaction.user.id, guildId, roleLevel);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${newOrderId}`)
      .setPlaceholder("Pick a service category...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const crewCutInfo = commData.crewCut > 0 || roleLevel === "trainer" || roleLevel === "manager" || roleLevel === "owner"
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;

    await interaction.editReply({
      embeds: [buildDraftEmbed(draft, commData.weekCommission, commData.rate, crewCutInfo)],
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
    const [catalogStr, r] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })
    ]);
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);
    const guildId = interaction.guildId ?? "";
    const commData = await getCommissionData(interaction.user.id, guildId, order.role_level);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));

    const crewCutInfo = commData.crewCut > 0 || ["trainer","manager","owner"].includes(order.role_level)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;

    await interaction.editReply({
      embeds: [buildDraftEmbed(order, commData.weekCommission, commData.rate, crewCutInfo)],
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

  // ── Max Performance — auto-add all top-tier performance items ──────────────
  if (action === "maxperf") {
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);

    const MAX_PERF_ITEMS = [
      { label: "Engine 4",       category: "Performance", price: 70000, cost: 40000, labour: 30000 },
      { label: "Turbo",          category: "Performance", price: 40000, cost: 10000, labour: 30000 },
      { label: "Suspension 4",   category: "Performance", price: 21000, cost: 12000, labour: 9000  },
      { label: "Transmission 3", category: "Performance", price: 26300, cost: 15000, labour: 11300 },
      { label: "Brakes 3",       category: "Performance", price: 16900, cost: 7500,  labour: 9400  },
    ];
    const perfLabels = new Set(MAX_PERF_ITEMS.map(i => i.label));

    // Remove any existing performance items that clash, keep everything else
    const existing = (order.items ?? []).filter((i: any) => !perfLabels.has(i.label));
    const items = [...existing, ...MAX_PERF_ITEMS];

    const newPartsCost = items.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour    = items.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal     = items.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(items), newPartsCost, newLabour, newTotal, orderId]
    });

    const [catalogStr, ur] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })
    ]);
    const updated = rowToOrder(ur.rows[0]);
    const guildId = interaction.guildId ?? "";
    const commData = await getCommissionData(interaction.user.id, guildId, updated.role_level);
    const crewCutInfo = ["trainer","manager","owner"].includes(updated.role_level)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;
    const catalog = JSON.parse(catalogStr ?? "{}");
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions((catalog.categories ?? []).map((c: string) => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, commData.weekCommission, commData.rate, crewCutInfo)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return true;
  }

  // ── Full Build — add entire preset package (~$225k) ─────────────────────────
  if (action === "fullpackage") {
    await interaction.deferUpdate();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return true;
    const order = rowToOrder(r.rows[0]);

    const FULL_PACKAGE = [
      { label: "Engine 4",       category: "Performance",    price: 70000, cost: 40000, labour: 30000 },
      { label: "Turbo",          category: "Performance",    price: 40000, cost: 10000, labour: 30000 },
      { label: "Suspension 4",   category: "Performance",    price: 21000, cost: 12000, labour: 9000  },
      { label: "Transmission 3", category: "Performance",    price: 26300, cost: 15000, labour: 11300 },
      { label: "Brakes 3",       category: "Performance",    price: 16900, cost: 7500,  labour: 9400  },
      { label: "Primary Color",  category: "Visual & Body",  price: 11500, cost: 1000,  labour: 10500 },
      { label: "Secondary Color",category: "Visual & Body",  price: 11500, cost: 1000,  labour: 10500 },
      { label: "Pearlescent",    category: "Visual & Body",  price: 11500, cost: 1000,  labour: 10500 },
      { label: "Wheels",         category: "Extras",         price:  3900, cost:  500,  labour: 3400  },
      { label: "Neon Kit",       category: "Neon & Lighting",price:  4000, cost: 1000,  labour: 3000  },
      { label: "Tire Smoke",     category: "Neon & Lighting",price:  4000, cost: 1000,  labour: 3000  },
      { label: "Window Tinting", category: "Neon & Lighting",price:  2100, cost: 1000,  labour: 1100  },
      { label: "Xenon Lighting", category: "Neon & Lighting",price:  2100, cost: 1000,  labour: 1100  },
    ]; // Total: $224,800

    const newPartsCost = FULL_PACKAGE.reduce((s, i) => s + i.cost,   0);
    const newLabour    = FULL_PACKAGE.reduce((s, i) => s + i.labour, 0);
    const newTotal     = FULL_PACKAGE.reduce((s, i) => s + i.price,  0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(FULL_PACKAGE), newPartsCost, newLabour, newTotal, orderId]
    });

    const [catalogStr2, ur2] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })
    ]);
    const updated2 = rowToOrder(ur2.rows[0]);
    const guildId2 = interaction.guildId ?? "";
    const commData2 = await getCommissionData(interaction.user.id, guildId2, updated2.role_level);
    const crewCutInfo2 = ["trainer","manager","owner"].includes(updated2.role_level)
      ? { amount: commData2.crewCut, rate: commData2.crewCutRate, label: commData2.crewCutLabel }
      : undefined;
    const catalog2 = JSON.parse(catalogStr2 ?? "{}");
    const catSelect2 = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions((catalog2.categories ?? []).map((c: string) => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(updated2, commData2.weekCommission, commData2.rate, crewCutInfo2)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect2),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return true;
  }

  // ── Discount modal ────────────────────────────────────────────────────────
  if (action === "discount") {
    const modal = new ModalBuilder()
      .setCustomId(`order:applydiscount:${orderId}`)
      .setTitle("💲 Apply Discount");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("percent")
          .setLabel("Discount % (1 – 100)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 10  for a 10% discount")
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
    const modal = new ModalBuilder().setCustomId(`order:setlabour:${orderId}`).setTitle("Edit Labour Amount");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("labour")
        .setLabel("Labour amount (e.g. 15000)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter custom labour amount...")
    ));
    await interaction.showModal(modal);
    return true;
  }

  // ── Complete Order ──────────────────────────────────────────────────────────
  if (action === "submit") {
    await interaction.deferUpdate();
    if (!(await requireRole(interaction, "mechanic"))) return true;

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
    const guildId = interaction.guildId ?? "";

    const commData = await getCommissionData(interaction.user.id, guildId, completed.role_level);
    const crewCutInfo = commData.crewCut > 0 || ["trainer","manager","owner"].includes(completed.role_level)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;

    const embed = buildOrderEmbed(
      completed,
      profile?.display_name ?? "Unknown",
      commData.weekCommission,
      commData.rate,
      crewCutInfo
    );

    const mechanicId = interaction.user.id;

    const activeTC = await db.execute({
      sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
      args: [mechanicId]
    });
    const isClockedIn = !!activeTC.rows[0];

    const newOrderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("order:newpanel")
        .setLabel("📋  New Order")
        .setStyle(ButtonStyle.Success),
      isClockedIn
        ? new ButtonBuilder().setCustomId("clockout:order").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId("clockin:order").setLabel("🟢  Clock In").setStyle(ButtonStyle.Primary)
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
