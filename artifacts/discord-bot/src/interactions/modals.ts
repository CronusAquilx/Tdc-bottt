import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig, getSetting, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildDraftEmbed, buildJobEmbed, COLORS, money } from "../lib/embeds.js";

export async function handleModal(interaction: ModalSubmitInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

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
      embeds: [buildDraftEmbed(updated, rate)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect), buttons]
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
