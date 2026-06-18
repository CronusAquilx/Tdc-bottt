import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} from "discord.js";
import { db, getProfile, rowToTimeclock } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildTimeclockEmbed } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("clock")
  .setDescription("Time tracking")
  .addSubcommand(s => s.setName("in").setDescription("Clock in to start your shift"))
  .addSubcommand(s =>
    s.setName("out")
      .setDescription("Clock out to end your shift")
      .addStringOption(o => o.setName("notes").setDescription("Session notes (optional)"))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "in") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const active = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1", args: [interaction.user.id] });
    if (active.rows[0]) {
      const t = rowToTimeclock(active.rows[0]);
      await interaction.editReply({ content: `⚠️ Already clocked in since **${new Date(t.clock_in_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}**. Use \`/clock out\` first.` });
      return;
    }
    const id = randomUUID();
    await db.execute({ sql: "INSERT INTO timeclock (id, mechanic_id, clock_in_time) VALUES (?, ?, datetime('now'))", args: [id, interaction.user.id] });
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [id] });
    const entry = rowToTimeclock(r.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const embed = buildTimeclockEmbed(profile?.display_name ?? "Unknown", entry.clock_in_time, null, 0, "pending", null);
    await interaction.editReply({ embeds: [embed] });
    await postToSalesChannel(interaction, interaction.user.id, embed);
    return;
  }

  if (sub === "out") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ ephemeral: true });
    const notes = interaction.options.getString("notes");
    const active = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1", args: [interaction.user.id] });
    if (!active.rows[0]) { await interaction.editReply({ content: "❌ You're not currently clocked in." }); return; }
    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;
    await db.execute({ sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, notes = ?, status = 'pending' WHERE id = ?", args: [mins, notes ?? null, entry.id] });
    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [entry.id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const embed = buildTimeclockEmbed(profile?.display_name ?? "Unknown", updated.clock_in_time, updated.clock_out_time, mins, "pending", notes ?? null);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`timeclock:approve:${entry.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`timeclock:reject:${entry.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    await postToSalesChannel(interaction, interaction.user.id, embed, [row]);
  }
}

async function postToSalesChannel(
  interaction: ChatInputCommandInteraction,
  mechanicId: string,
  embed: EmbedBuilder,
  components?: ActionRowBuilder<ButtonBuilder>[]
) {
  try {
    if (!interaction.guild) return;
    const profile = await getProfile(mechanicId);
    if (!profile?.sales_channel_id) return;
    const ch = await interaction.guild.channels.fetch(profile.sales_channel_id);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed], components: components ?? [] });
  } catch { /* ignore */ }
}
