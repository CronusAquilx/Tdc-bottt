import {
  ButtonInteraction, ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildLoaEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

function rowToLoa(row: unknown) {
  const c = (i: number) => {
    if (Array.isArray(row)) return row[i];
    if (row && typeof row === "object") return (row as any)[i];
    return undefined;
  };
  return {
    id:                 String(c(0) ?? ""),
    mechanic_id:        String(c(1) ?? ""),
    guild_id:           String(c(2) ?? ""),
    reason:             String(c(3) ?? ""),
    start_date:         String(c(4) ?? ""),
    return_date:        String(c(5) ?? ""),
    notes:              c(6) ? String(c(6)) : undefined,
    status:             String(c(7) ?? "pending"),
    reviewed_by:        c(8) ? String(c(8)) : null,
    discord_message_id: c(9) ? String(c(9)) : null,
    created_at:         String(c(10) ?? ""),
  };
}

// ── Show LOA request modal ─────────────────────────────────────────────────────
export async function showLoaModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder().setCustomId("loa:submit").setTitle("Leave of Absence Request");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for LOA")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
        .setPlaceholder("Personal reasons, vacation, school, etc...")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("start_date")
        .setLabel("Start Date (e.g. 2026-07-01)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("YYYY-MM-DD")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("return_date")
        .setLabel("Expected Return Date (e.g. 2026-07-15)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("YYYY-MM-DD")
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Additional Notes (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(300)
        .setPlaceholder("Anything else the team should know...")
    )
  );
  await interaction.showModal(modal);
}

// ── Handle LOA modal submission ────────────────────────────────────────────────
export async function handleLoaModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== "loa:submit") return false;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const reason      = interaction.fields.getTextInputValue("reason");
  const startDate   = interaction.fields.getTextInputValue("start_date").trim();
  const returnDate  = interaction.fields.getTextInputValue("return_date").trim();
  const notes       = interaction.fields.getTextInputValue("notes") || undefined;

  // Basic date validation
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(returnDate)) {
    await interaction.editReply({ content: "❌ Invalid date format. Use **YYYY-MM-DD** (e.g. `2026-07-01`)." });
    return true;
  }
  if (new Date(returnDate) < new Date(startDate)) {
    await interaction.editReply({ content: "❌ Return date must be after the start date." });
    return true;
  }

  const profile = await getProfile(interaction.user.id);
  const mechanicName = profile?.display_name ?? interaction.user.username;

  const loaId = randomUUID();
  await db.execute({
    sql: "INSERT INTO loa_requests (id, mechanic_id, guild_id, reason, start_date, return_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [loaId, interaction.user.id, guild.id, reason, startDate, returnDate, notes ?? null]
  });

  const embed = buildLoaEmbed({ mechanic_name: mechanicName, reason, start_date: startDate, return_date: returnDate, notes, status: "pending" });

  const reviewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`loa:approve:${loaId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`loa:deny:${loaId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
  );

  // Post to LOA channel
  const config = await getGuildConfig(guild.id);
  let msgId = "";
  if (config?.loa_channel_id) {
    try {
      const ch = await guild.channels.fetch(config.loa_channel_id);
      if (ch?.isTextBased()) {
        const msg = await (ch as any).send({ content: `📋 New LOA request from <@${interaction.user.id}>`, embeds: [embed], components: [reviewRow] });
        msgId = msg.id;
        await db.execute({ sql: "UPDATE loa_requests SET discord_message_id = ? WHERE id = ?", args: [msg.id, loaId] });
      }
    } catch { /* ignore */ }
  }

  await interaction.editReply({
    content: msgId
      ? `✅ Your LOA request has been submitted and is pending review.\n📅 **${startDate}** → **${returnDate}**`
      : `✅ LOA request saved. No LOA channel configured yet — ask an admin to set one up.`,
    embeds: [embed]
  });
  return true;
}

// ── Handle LOA approve/deny buttons ───────────────────────────────────────────
export async function handleLoaButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");
  if (ns !== "loa") return false;
  const loaId = rest.join(":");

  if (action === "approve" || action === "deny") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferUpdate();

    const status = action === "approve" ? "approved" : "denied";
    await db.execute({
      sql: "UPDATE loa_requests SET status = ?, reviewed_by = ? WHERE id = ?",
      args: [status, interaction.user.id, loaId]
    });

    const r = await db.execute({ sql: "SELECT * FROM loa_requests WHERE id = ?", args: [loaId] });
    if (!r.rows[0]) return true;
    const loa = rowToLoa(r.rows[0]);
    const mechanic = await getProfile(loa.mechanic_id);
    const mechanicName = mechanic?.display_name ?? "Unknown";
    const reviewer = await getProfile(interaction.user.id);

    const embed = buildLoaEmbed({
      mechanic_name: mechanicName,
      reason: loa.reason,
      start_date: loa.start_date,
      return_date: loa.return_date,
      notes: loa.notes,
      status
    });
    embed.addFields({ name: `${status === "approved" ? "✅" : "❌"} Reviewed By`, value: reviewer?.display_name ?? "Manager", inline: true });

    await interaction.editReply({ embeds: [embed], components: [] });

    // DM the mechanic the decision
    try {
      const user = await interaction.client.users.fetch(loa.mechanic_id);
      const dmEmbed = buildLoaEmbed({ mechanic_name: mechanicName, reason: loa.reason, start_date: loa.start_date, return_date: loa.return_date, notes: loa.notes, status });
      await user.send({
        content: status === "approved"
          ? `✅ Your LOA request (**${loa.start_date}** → **${loa.return_date}**) has been **approved**!`
          : `❌ Your LOA request (**${loa.start_date}** → **${loa.return_date}**) has been **denied**. Reach out to management if you have questions.`,
        embeds: [dmEmbed]
      });
    } catch { /* DMs closed */ }

    return true;
  }

  return false;
}
