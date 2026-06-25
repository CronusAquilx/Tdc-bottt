import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig, getSetting, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildDraftEmbed, buildJobEmbed, COLORS, money } from "../lib/embeds.js";
import { mainDraftButtonRows } from "./draftbuttons.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // Helper: rebuild category select + main draft buttons
  async function refreshDraftView(ordId: string) {
    const [catalogStr, r, allTimeTotalR] = await Promise.all([
      getSetting("parts_catalog"),
      db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [ordId] }),
      db.execute({ sql: "SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete'", args: [interaction.user.id] })
    ]);
    const order = rowToOrder(r.rows[0]);
    const allTimeTotal = Number(allTimeTotalR.rows[0]?.[0] ?? 0);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${ordId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));
    return { order, allTimeTotal, catSelect };
  }

  // ── Edit Labour ────────────────────────────────────────────────────────────
  if (ns === "order" && action === "setlabour") {
    await interaction.deferReply({ ephemeral: true });
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

    const { order: updated, allTimeTotal, catSelect } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, allTimeTotal)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Max Performance ────────────────────────────────────────────────────────
  if (ns === "order" && action === "addmaxperf") {
    await interaction.deferReply({ ephemeral: true });
    const amtStr = interaction.fields.getTextInputValue("amount").replace(/[$,]/g, "");
    const amount = parseFloat(amtStr);
    if (isNaN(amount) || amount <= 0) {
      await interaction.editReply({ content: "❌ Invalid amount — enter a number like `100000`." });
      return;
    }

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);

    // Remove any existing Max Performance entry, then add fresh
    const items: any[] = (order.items ?? []).filter((i: any) => i.label !== "Max Performance");
    items.push({ label: "Max Performance", price: amount, cost: 0, labour: amount, category: "Performance" });

    const newPartsCost = items.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour    = items.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal     = items.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(items), newPartsCost, newLabour, newTotal, extra]
    });

    const { order: updated, allTimeTotal, catSelect } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, allTimeTotal)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Body Parts ──────────────────────────────────────────────────────────────
  if (ns === "order" && action === "addextras") {
    await interaction.deferReply({ ephemeral: true });
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

    const { order: updated, allTimeTotal, catSelect } = await refreshDraftView(extra);
    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, allTimeTotal)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(extra)
      ]
    });
    return;
  }

  // ── Job apply modal ────────────────────────────────────────────────────────
  if (ns === "job" && action === "applymodal") {
    await interaction.deferReply({ ephemeral: true });
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
