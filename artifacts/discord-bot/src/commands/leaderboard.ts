import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, TextChannel } from "discord.js";
import { db, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildLeaderboardEmbed, getWeekStart } from "../lib/leaderboard.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Post the weekly leaderboard (manager+)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = await getGuildConfig(guild.id);

  if (!config?.leaderboard_channel_id) {
    await interaction.editReply({
      content: "❌ No leaderboard channel set. Go to the Admin Panel → **Config** and set one up first."
    });
    return;
  }

  const ch = await guild.channels.fetch(config.leaderboard_channel_id).catch(() => null);
  if (!ch?.isTextBased()) {
    await interaction.editReply({ content: "❌ Leaderboard channel not found or not a text channel." });
    return;
  }

  await postLeaderboard(ch as TextChannel);
  await interaction.editReply({ content: `✅ Leaderboard posted to <#${ch.id}>!` });
}

export async function postLeaderboard(channel: TextChannel) {
  const weekStart = getWeekStart();
  const r = await db.execute({
    sql: `SELECT p.discord_id, p.display_name,
                 COUNT(o.id) as order_count,
                 COALESCE(SUM(o.total), 0) as total_revenue
          FROM profiles p
          JOIN orders o ON o.mechanic_id = p.discord_id
          WHERE o.status = 'complete' AND o.completed_at >= ?
          GROUP BY p.discord_id, p.display_name
          HAVING order_count > 0
          ORDER BY total_revenue DESC
          LIMIT 15`,
    args: [weekStart]
  });

  const entries = r.rows.map(row => ({
    discord_id:    String(row[0] ?? ""),
    display_name:  String(row[1] ?? ""),
    order_count:   Number(row[2] ?? 0),
    total_revenue: Number(row[3] ?? 0),
  }));

  const embed = buildLeaderboardEmbed(entries, new Date());

  // Try to find and update an existing leaderboard message
  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = [...recent.values()].find(m =>
      m.author.bot && m.embeds[0]?.title?.includes("WEEKLY LEADERBOARD")
    );
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  } catch { /* fallthrough to send */ }

  await channel.send({ embeds: [embed] });
}
