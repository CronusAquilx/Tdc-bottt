import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, getSetting, rowToOrder, nextOrderNumber } from "../db.js";
import { requireRole, detectUserRoleLevel } from "../lib/roles.js";
import { buildDraftEmbed, buildJobEmbed, buildOrderEmbed, buildClockInPromptEmbed, COLORS, money } from "../lib/embeds.js";
import { mainDraftButtonRows, getCommissionData } from "./draftbuttons.js";
import { randomUUID } from "../lib/utils.js";
import { logEvent } from "../lib/eventLog.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── New Order: customer name modal → create draft and show category selector ─
  if (ns === "order" && action === "startorder") {
    const customerName = interaction.fields.getTextInputValue("customer_name").trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!(await requireRole(interaction, "mechanic"))) return;

    const clickerId = interaction.user.id;
    const guildId   = interaction.guildId ?? "";
    const clickerRole = await detectUserRoleLevel(interaction);
    const isManager   = clickerRole === "manager" || clickerRole === "owner";

    let targetMechanicId  = clickerId;
    let targetDisplayName: string | undefined;

    if (isManager) {
      const clickerProfile = await getProfile(clickerId);
      if (interaction.channelId && interaction.channelId !== clickerProfile?.sales_channel_id) {
        const ownerRow = await db.execute({
          sql: "SELECT discord_id, display_name FROM profiles WHERE sales_channel_id = ? LIMIT 1",
          args: [interaction.channelId]
        });
        if (ownerRow.rows[0]) {
          targetMechanicId  = String(ownerRow.rows[0][0] ?? clickerId);
          targetDisplayName = String(ownerRow.rows[0][1] ?? "");
        }
      }
    }

    // Check clock-in state (required for mechanics and for managers acting as themselves)
    if (!isManager || targetMechanicId === clickerId) {
      const active = await db.execute({
        sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
        args: [clickerId]
      });
      if (!active.rows[0]) {
        // Store customer name so clockin:then:order can apply it after clocking in
        await db.execute({
          sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
          args: [`pending_customer_name_${clickerId}`, customerName]
        });
        const clockRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("clockin:then:order").setLabel("🟢  Clock In & Start Order").setStyle(ButtonStyle.Success)
        );
        await interaction.editReply({ embeds: [buildClockInPromptEmbed()], components: [clockRow] });
        return;
      }
    }

    const roleLevel = targetMechanicId === clickerId ? clickerRole : "mechanic";

    // Clean up stale drafts from before the last reset
    const resetTs = await getSetting("order_number_reset_ts");
    if (resetTs) {
      await db.execute({
        sql: `DELETE FROM orders WHERE mechanic_id = ? AND status = 'draft'
              AND (guild_id = ? OR guild_id = '')
              AND datetime(COALESCE(created_at, '2000-01-01')) < datetime(?)`,
        args: [targetMechanicId, guildId, resetTs]
      });
    }

    // Resume existing draft or create a new one
    let orderId: string;
    const existingDraftR = await db.execute({
      sql: `SELECT id FROM orders WHERE mechanic_id = ? AND status = 'draft'
            AND (guild_id = ? OR guild_id = '')
            ORDER BY created_at DESC LIMIT 1`,
      args: [targetMechanicId, guildId]
    });

    if (existingDraftR.rows[0]) {
      orderId = String(existingDraftR.rows[0][0]);
      await db.execute({ sql: "UPDATE orders SET customer_name = ? WHERE id = ?", args: [customerName, orderId] });
    } else {
      orderId = randomUUID();
      let orderNumber = await nextOrderNumber();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await db.execute({
            sql: "INSERT INTO orders (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes, role_level, customer_name) VALUES (?, ?, ?, ?, 'draft', '[]', 0, 0, 0, '', ?, ?)",
            args: [orderId, orderNumber, targetMechanicId, guildId, roleLevel, customerName]
          });
          break;
        } catch (err: any) {
          if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" && attempt < 4) {
            orderNumber = await nextOrderNumber();
            continue;
          }
          throw err;
        }
      }
      logEvent({ kind: "order_created", guildId, userId: targetMechanicId, userName: targetDisplayName ?? interaction.user.username, orderId, orderNumber });
    }

    const [catalogStr, draft] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] }).then(r => rowToOrder(r.rows[0]))
    ]);
    const commData = await getCommissionData(targetMechanicId, guildId, roleLevel);
    let catalog: any = {};
    try { catalog = JSON.parse(catalogStr ?? "{}"); } catch { /* use empty */ }
    const categories: string[] = Array.isArray(catalog.categories) && catalog.categories.length > 0 ? catalog.categories : [];

    if (categories.length === 0) {
      await interaction.editReply({ content: "⚠️ No service catalog is set up yet. Ask a manager to configure it with `/settings`." });
      return;
    }

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Pick a service category...")
      .addOptions(categories.map((cat: string) => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const crewCutInfo = commData.crewCut > 0 || ["trainer","manager","owner"].includes(roleLevel)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel } : undefined;

    const headerNote = (isManager && targetMechanicId !== clickerId)
      ? `> 📋 **On behalf of ${targetDisplayName ?? `<@${targetMechanicId}>`}**  ·  👤 Customer: **${customerName}**`
      : `> 👤 **Customer:** ${customerName}`;

    await interaction.editReply({
      content: headerNote,
      embeds: [buildDraftEmbed(draft, commData.weekCommission, commData.rate, crewCutInfo)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return;
  }

  // ── Set customer name on existing draft then complete it ───────────────────
  if (ns === "order" && action === "setcustomer") {
    const orderId    = extra;
    const custName   = interaction.fields.getTextInputValue("customer_name").trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await requireRole(interaction, "mechanic"))) return;

    await db.execute({ sql: "UPDATE orders SET customer_name = ? WHERE id = ?", args: [custName, orderId] });

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);

    if (!order.items.length) {
      await interaction.editReply({ content: "❌ Add at least one service before completing the order." });
      return;
    }

    const mechanicId      = order.mechanic_id;
    const mechanicRoleLevel = order.role_level ?? "mechanic";
    const guildId         = interaction.guildId ?? "";

    const [profile, prevCommData] = await Promise.all([
      getProfile(mechanicId),
      getCommissionData(mechanicId, guildId, mechanicRoleLevel)
    ]);

    await db.execute({
      sql: "UPDATE orders SET status = 'complete', completed_at = datetime('now') WHERE id = ?",
      args: [orderId]
    });

    const ur       = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    const completed = rowToOrder(ur.rows[0]);
    const thisOrderCut       = Math.round(completed.labour * prevCommData.rate);
    const finalWeekCommission = prevCommData.weekCommission + thisOrderCut;

    const crewCutInfo = prevCommData.crewCut > 0 || ["trainer","manager","owner"].includes(mechanicRoleLevel)
      ? { amount: prevCommData.crewCut, rate: prevCommData.crewCutRate, label: prevCommData.crewCutLabel } : undefined;

    const embed = buildOrderEmbed(completed, profile?.display_name ?? "Unknown", finalWeekCommission, prevCommData.rate, crewCutInfo);

    const activeTC = await db.execute({
      sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1",
      args: [mechanicId]
    });
    const isClockedIn = !!activeTC.rows[0];

    const newOrderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("order:newpanel").setLabel("📋  New Order").setStyle(ButtonStyle.Success),
      isClockedIn
        ? new ButtonBuilder().setCustomId("clockout:order").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId("clockin:order").setLabel("🟢  Clock In").setStyle(ButtonStyle.Primary)
    );
    const payRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`orderpay:start:${mechanicId}`).setLabel("💸  Pay").setStyle(ButtonStyle.Primary)
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

    if (interaction.guild) {
      try {
        const gConfig = await getGuildConfig(guildId);
        const logChanId = gConfig?.orders_channel_id ?? gConfig?.log_channel_id;
        if (logChanId && logChanId !== profile?.sales_channel_id) {
          const logCh = await interaction.guild.channels.fetch(logChanId).catch(() => null);
          if (logCh?.isTextBased()) await (logCh as any).send({ embeds: [embed] });
        }
      } catch { /* ignore */ }
    }

    logEvent({ kind: "order_completed", guildId, userId: mechanicId, orderId, orderNumber: completed.order_number, amount: Math.round(completed.labour), detail: `total=${completed.total} parts=${completed.parts_cost}` });

    await interaction.editReply({
      content: postedTo
        ? `✅ **${completed.order_number}** complete! Posted to <#${postedTo}>`
        : `✅ **${completed.order_number}** complete!\n*Set up a sales channel to auto-post orders.*`,
      embeds: [embed],
      components: []
    });
    return;
  }

  // Helper: rebuild category select + main draft buttons with commission info
  async function refreshDraftView(ordId: string) {
    const [catalogStr, r] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [ordId] })
    ]);
    const order = rowToOrder(r.rows[0]);
    const guildId = interaction.guildId ?? "";
    // Use the order's mechanic_id (not the clicker) so on-behalf edits show the
    // correct commission for the assigned mechanic, not the manager's own rate.
    const mechanicId   = order.mechanic_id ?? interaction.user.id;
    const orderRole    = (order as any).role_level ?? "mechanic";
    const commData = await getCommissionData(mechanicId, guildId, orderRole);
    const crewCutInfo = ["trainer","manager","owner"].includes(orderRole)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${ordId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));
    return { order, weekCommission: commData.weekCommission, rate: commData.rate, crewCutInfo, catSelect };
  }

  // ── Edit Labour ────────────────────────────────────────────────────────────
  if (ns === "order" && action === "setlabour") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const labourStr = interaction.fields.getTextInputValue("labour").replace(/[$,]/g, "");
    const labour = parseFloat(labourStr);
    if (isNaN(labour) || labour < 0) {
      await interaction.editReply({ content: "❌ Invalid amount — enter a number like `15000`." });
      return;
    }
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);
    const newTotal = order.parts_cost + labour;
    await db.execute({ sql: "UPDATE orders SET labour = ?, total = ? WHERE id = ?", args: [labour, newTotal, extra] });

    const { order: updated, weekCommission, rate, crewCutInfo: cci0, catSelect } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, weekCommission, rate, cci0)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Discount ────────────────────────────────────────────────────────────────
  if (ns === "order" && action === "applydiscount") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pctStr = interaction.fields.getTextInputValue("percent").replace(/[%\s]/g, "");
    const pct = parseFloat(pctStr);
    if (isNaN(pct) || pct < 1 || pct > 100) {
      await interaction.editReply({ content: "❌ Enter a discount between **1** and **100**." });
      return;
    }

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) {
      await interaction.editReply({ content: "❌ This order no longer exists — it may have been cancelled. Start a new order with the **📋 New Order** button." });
      return;
    }
    const order = rowToOrder(r.rows[0]);

    if (!order.items.length) {
      await interaction.editReply({ content: "❌ Add items to the order before applying a discount." });
      return;
    }

    const mult = 1 - pct / 100;
    const discounted = order.items.map((i: any) => ({
      ...i,
      price:  Math.round(i.price  * mult),
      cost:   Math.round(i.cost   * mult),
      labour: Math.round(i.labour * mult),
    }));

    const newPartsCost = discounted.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour    = discounted.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal     = discounted.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(discounted), newPartsCost, newLabour, newTotal, extra]
    });

    const { order: updated, weekCommission, rate, crewCutInfo, catSelect } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, weekCommission, rate, crewCutInfo)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Body Parts ──────────────────────────────────────────────────────────────
  if (ns === "order" && action === "addextras") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const qtyStr = interaction.fields.getTextInputValue("quantity").trim();
    const qty = parseInt(qtyStr, 10);
    if (isNaN(qty) || qty <= 0) {
      await interaction.editReply({ content: "❌ Enter a valid number of body parts (e.g. `3`)." });
      return;
    }

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);

    const extrasPrice = qty * 500;
    // Remove existing body parts line if present, add fresh
    const items: any[] = (order.items ?? []).filter((i: any) => i.category !== "__extras__");
    items.push({ label: `Body Parts ×${qty}`, price: extrasPrice, cost: 0, labour: extrasPrice, category: "__extras__" });

    const newPartsCost = items.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour    = items.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal     = items.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(items), newPartsCost, newLabour, newTotal, extra]
    });

    const { order: updated2, weekCommission: wc2, rate: r2, crewCutInfo: cci2, catSelect: cs2 } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated2, wc2, r2, cci2)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(cs2),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Admin: payroll set individual pay ─────────────────────────────────────
  if (ns === "admin" && action === "payroll" && extra.startsWith("setpay:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await requireRole(interaction, "manager"))) return;
    const memberId = extra.replace("setpay:", "");
    const amountStr = interaction.fields.getTextInputValue("amount").replace(/[$,\s]/g, "");
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount < 0) {
      await interaction.editReply({ content: "❌ Invalid amount — enter a dollar value like `5000` or `0` to clear." });
      return;
    }
    const profile = await getProfile(memberId);
    if (!profile) {
      await interaction.editReply({ content: "❌ User not found in crew." });
      return;
    }
    if (amount === 0) {
      // Clear — reset adjustment and snapshot
      await db.execute({
        sql: "UPDATE profiles SET commission_adjustment = 0, commission_labour_snapshot = 0 WHERE discord_id = ?",
        args: [memberId]
      });
      await interaction.editReply({ content: `✅ Cleared commission for **${profile.display_name}** — back to % calculation.` });
    } else {
      // Snapshot current labour so new orders add on top of the set amount
      const SINCE_RESET = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
      const snapR = await db.execute({
        sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE mechanic_id = ? AND status IN ('complete','approved','paid') AND ${SINCE_RESET}`,
        args: [memberId]
      });
      const labourSnapshot = Number(snapR.rows[0]?.[0] ?? 0);
      await db.execute({
        sql: "UPDATE profiles SET commission_adjustment = ?, commission_labour_snapshot = ? WHERE discord_id = ?",
        args: [amount, labourSnapshot, memberId]
      });
      await interaction.editReply({ content: `✅ Set **${profile.display_name}**'s commission to **$${Math.round(amount).toLocaleString()}** — new orders will add on top.` });
    }
    return;
  }

  // ── Job apply modal ────────────────────────────────────────────────────────
  if (ns === "job" && action === "applymodal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const jobId = extra;
    const message = interaction.fields.getTextInputValue("message");
    const experience = interaction.fields.getTextInputValue("experience");
    const r = await db.execute({ sql: "SELECT title, posted_by FROM jobs WHERE id = ?", args: [jobId] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ This job posting no longer exists." }); return; }
    const title = String(r.rows[0][0]);
    const posterId = String(r.rows[0][1]);
    const applicantProfile = await getProfile(interaction.user.id);
    const applicantName = applicantProfile?.display_name ?? interaction.user.username;

    const applicationEmbed = new EmbedBuilder()
      .setTitle(`📩  New Application — ${title}`)
      .setColor(COLORS.submitted)
      .setDescription(`**${applicantName}** applied for **${title}**`)
      .addFields(
        { name: "👤 Applicant",  value: `${applicantName} (<@${interaction.user.id}>)`, inline: true },
        { name: "🕐 Applied",    value: `<t:${Math.floor(Date.now() / 1000)}:R>`,        inline: true },
        { name: "\u200b",        value: "\u200b",                                         inline: true },
        { name: "💬 Message",    value: message },
        ...(experience ? [{ name: "📋 Experience", value: experience }] : [])
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Job Application" })
      .setTimestamp();

    let dmSent = false;
    try {
      const poster = await interaction.client.users.fetch(posterId);
      await poster.send({ embeds: [applicationEmbed] });
      dmSent = true;
    } catch { /* DMs may be closed */ }

    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.log_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.log_channel_id);
          if (ch?.isTextBased()) await (ch as any).send({ embeds: [applicationEmbed] });
        } catch { /* ignore */ }
      }
    }

    await interaction.editReply({
      content: dmSent
        ? `✅ Your application for **${title}** has been sent to the team!`
        : `✅ Your application for **${title}** has been submitted.`
    });
    return;
  }
}
