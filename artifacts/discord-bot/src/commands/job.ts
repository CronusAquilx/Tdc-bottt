import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";
import { randomUUID, paginate } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("job")
  .setDescription("Job posting management (owner+)")
  .addSubcommand(s => s.setName("post").setDescription("Post a new job opening"))
  .addSubcommand(s =>
    s.setName("list")
      .setDescription("List active job postings")
      .addIntegerOption(o => o.setName("page").setDescription("Page number").setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName("delete")
      .setDescription("Delete a job posting")
      .addStringOption(o => o.setName("id").setDescription("Job ID").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "post") {
    if (!(await requireRole(interaction, "owner"))) return;
    const modal = new ModalBuilder().setCustomId("job:posting").setTitle("Post a Job — Tokyo Drift Customs");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Job Title").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. Performance Builder")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("body").setLabel("Job Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder("Tokyo Drift Customs — Open\nPull up and get your car built right 🔧🔥\n...")
      )
    );
    await interaction.showModal(modal);
    return;
  }

  if (sub === "list") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const page = (interaction.options.getInteger("page") ?? 1) - 1;
    const r = await db.execute("SELECT id, title, created_at FROM jobs ORDER BY created_at DESC");
    const { items, total, pages } = paginate(r.rows as unknown as any[][], page, 5);
    if (!items.length) { await interaction.editReply({ content: "No active job postings." }); return; }
    const embed = new EmbedBuilder()
      .setTitle("📋 Active Job Postings").setColor(COLORS.primary)
      .setDescription(items.map(j => `**[${String(j[0]).slice(0, 8)}]** ${String(j[1])} — ${new Date(String(j[2])).toLocaleDateString()}`).join("\n"))
      .setFooter({ text: `Tokyo Drift Customs | Page ${page + 1} / ${pages} · ${total} total` }).setTimestamp();
    const buttons = items.slice(0, 5).map(j =>
      new ButtonBuilder().setCustomId(`job:delete:${String(j[0])}`).setLabel(`🗑️ ${String(j[1]).slice(0, 20)}`).setStyle(ButtonStyle.Danger)
    );
    await interaction.editReply({ embeds: [embed], components: buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [] });
    return;
  }

  if (sub === "delete") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getString("id", true);
    const r = await db.execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
    if (!r.rows[0]) { await interaction.editReply({ content: "❌ Job not found." }); return; }
    const title = String(r.rows[0][2] ?? "");
    const msgId = String(r.rows[0][4] ?? "");
    await db.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [id] });
    if (msgId && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.jobs_channel_id) { try { const ch = await interaction.guild.channels.fetch(config.jobs_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).messages.fetch(msgId); await msg.delete(); } } catch { /* ignore */ } }
    }
    await interaction.editReply({ content: `✅ Job **${title}** deleted.` });
  }
}
