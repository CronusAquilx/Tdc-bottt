import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { db, getProfile, rowToTimeclock } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildTimeclockEmbed, COLORS } from "../lib/embeds.js";
import { formatDuration } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("timeclock")
  .setDescription("Manage timeclock entries (trainer+)")
  .addSubcommand(s =>
    s.setName("review")
      .setDescription("Review pending timeclock entries")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("history")
      .setDescription("View timeclock history")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "trainer"))) return;
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser("mechanic", true);
  const profile = await getProfile(target.id);
  if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }

  if (sub === "review") {
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND status = 'pending' AND clock_out_time IS NOT NULL ORDER BY created_at DESC", args: [target.id] });
    if (!r.rows.length) { await interaction.editReply({ content: `✅ No pending entries for **${profile.display_name}**.` }); return; }
    for (const row of r.rows.slice(0, 5)) {
      const entry = rowToTimeclock(row);
      const embed = buildTimeclockEmbed(profile.display_name, entry.clock_in_time, entry.clock_out_time, entry.duration_minutes, entry.status, entry.notes);
      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`timeclock:approve:${entry.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`timeclock:reject:${entry.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );
      await interaction.followUp({ embeds: [embed], components: [btnRow], ephemeral: true });
    }
    return;
  }

  if (sub === "history") {
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? ORDER BY created_at DESC LIMIT 10", args: [target.id] });
    if (!r.rows.length) { await interaction.editReply({ content: `No timeclock entries for **${profile.display_name}**.` }); return; }
    const lines = r.rows.map(row => {
      const entry = rowToTimeclock(row);
      return `${new Date(entry.clock_in_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${formatDuration(entry.duration_minutes)} — \`${entry.status.toUpperCase()}\``;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⏰ Timeclock History · ${profile.display_name}`)
      .setColor(COLORS.submitted)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }
}
