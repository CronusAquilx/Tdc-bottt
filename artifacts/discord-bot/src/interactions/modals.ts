import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig, nextOrderNumber, getSetting, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, buildDraftEmbed, buildJobEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── New order notes ────────────────────────────────────────────────────────
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
    const categories: string[] = catalog.categories ?? [];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Select a service category...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
    );

    const profile = await getProfile(interaction.user.id);
    const rate = profile?.commission_rate ?? 0.3;

    const draft = rowToOrder(
      (await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })).rows[0]
    );

    await interaction.editReply({
      embeds: [buildDraftEmbed(draft, rate)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect), buttons]
    });
    return;
  }

  // ── Edit Labour ────────────────────────────────────────────────────────────
  if (ns === "order" && action === "setlabour") {
    await interaction.deferReply({ ephemeral: true });
    const labourStr = interaction.fields.getTextInputValue("labour").replace(/[$,]/g, "");
    const labour = parseFloat(labourStr);
    if (isNaN(labour) || labour < 0) {
      await interaction.editReply({ content: "❌ Invalid labour amount." });
      return;
    }
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Order not found." }); return; }
    const order = rowToOrder(r.rows[0]);
    const newTotal = order.parts_cost + labour;
    await db.execute({ sql: "UPDATE orders SET labour = ?, total = ? WHERE id = ?", args: [labour, newTotal, extra] });

    const updated = rowToOrder((await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] })).rows[0]);
    const profile = await getProfile(interaction.user.id);
    const rate = profile?.commission_rate ?? 0.3;

    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${extra}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:editlabour:${extra}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`order:submit:${extra}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:cancel:${extra}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({
      content: `✅ Labour updated to **${money(labour)}** · Total: **${money(newTotal)}**`,
      embeds: [buildDraftEmbed(updated, rate)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect), buttons]
    });
    return;
  }

  // ── Job posting modal ──────────────────────────────────────────────────────
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
        try {
          const ch = await interaction.guild.channels.fetch(config.jobs_channel_id);
          if (ch?.isTextBased()) { const msg = await (ch as any).send({ embeds: [embed], components: [row] }); msgId = msg.id; }
        } catch { /* ignore */ }
      }
    }
    await db.execute({ sql: "INSERT INTO jobs (id, posted_by, title, body, discord_message_id) VALUES (?, ?, ?, ?, ?)", args: [jobId, interaction.user.id, title, body, msgId] });
    const jobsCh = interaction.guild ? (await getGuildConfig(interaction.guild.id))?.jobs_channel_id : null;
    await interaction.editReply({
      content: msgId
        ? `✅ Job **${title}** posted${jobsCh ? ` to <#${jobsCh}>` : ""}!`
        : `✅ Job **${title}** saved. Use \`/setup jobs-channel\` to post publicly.`
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
      .addFields(
        { name: "Applicant", value: `${applicantName} (<@${interaction.user.id}>)`, inline: true },
        { name: "Applied", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        { name: "Message", value: message },
        ...(experience ? [{ name: "Experience", value: experience }] : [])
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
        ? `✅ Your application for **${title}** has been sent!`
        : `✅ Your application for **${title}** has been submitted.`
    });
    return;
  }
}
