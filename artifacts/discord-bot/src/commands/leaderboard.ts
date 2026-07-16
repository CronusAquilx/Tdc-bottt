import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, TextChannel, MessageFlags } from "discord.js";
import { db, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildLeaderboardEmbed } from "../lib/leaderboard.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Post or refresh the revenue leaderboard (manager+)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
  await interaction.editReply({ content: `✅ Leaderboard refreshed in <#${ch.id}>!` });
}

export async function postLeaderboard(channel: TextChannel) {
  // All-time revenue — every completed/approved/paid order ever, no pay-period boundary.
  // Sorted by customer revenue DESC so the board reflects money made for the shop.
  const r = await db.execute({
    sql: `SELECT p.discord_id, p.display_name,
                 COUNT(o.id) AS order_count,
                 COALESCE(SUM(COALESCE(o.customer_total_override, o.total)), 0) AS total_revenue,
                 COALESCE(SUM(o.labour), 0) AS total_labour,
                 COALESCE(p.commission_rate, 0.3) AS commission_rate
          FROM profiles p
          JOIN orders o ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved','paid')
          GROUP BY p.discord_id, p.display_name, p.commission_rate
          HAVING order_count > 0
          ORDER BY total_revenue DESC
          LIMIT 15`,
    args: []
  });

  const entries = r.rows.map(row => ({
    discord_id:      String(row[0] ?? ""),
    display_name:    String(row[1] ?? ""),
    order_count:     Number(row[2] ?? 0),
    total_revenue:   Number(row[3] ?? 0),
    total_labour:    Number(row[4] ?? 0),
    commission_rate: Number(row[5] ?? 0.3),
  }));

  const embed = buildLeaderboardEmbed(entries, new Date());

  // Edit the existing pinned board if it exists, otherwise post fresh
  try {
    const recent = await channel.messages.fetch({ limit: 25 });
    const existing = [...recent.values()].find(m =>
      m.author.bot && (m.embeds[0]?.title?.includes("LEADERBOARD") || m.embeds[0]?.title?.includes("REVENUE"))
    );
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  } catch { /* fallthrough to send */ }

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch { /* ignore — missing perms */ }
}
