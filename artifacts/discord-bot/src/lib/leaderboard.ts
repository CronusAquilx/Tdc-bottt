import { EmbedBuilder } from "discord.js";
import { COLORS } from "./embeds.js";

export type LeaderEntry = {
  discord_id: string;
  display_name: string;
  order_count: number;
  total_revenue: number;
};

const MEDALS = ["🥇", "🥈", "🥉"];
const RANK_EMOJI: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

function getWeekBounds(): { start: Date; end: Date; label: string } {
  const now   = new Date();
  const day   = now.getUTCDay(); // 0=Sun, 1=Mon
  const diff  = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() + diff);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { start, end, label: `${fmt(start)} – ${fmt(end)}` };
}

export function buildLeaderboardEmbed(entries: LeaderEntry[], updatedAt: Date): EmbedBuilder {
  const { label } = getWeekBounds();

  if (!entries.length) {
    return new EmbedBuilder()
      .setTitle("🏆  WEEKLY LEADERBOARD  ·  TOKYO DRIFT CUSTOMS")
      .setColor(COLORS.gold)
      .setDescription(
        `**Week of ${label}**\n\n` +
        "*No completed orders yet this week. Get to work! 🔧*"
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  Resets every Monday" })
      .setTimestamp(updatedAt);
  }

  const topRevenue = entries[0]?.total_revenue ?? 1;

  const rows = entries.map((e, i) => {
    const pos    = i + 1;
    const medal  = MEDALS[i] ?? `**${pos}.**`;
    const bar    = buildBar(e.total_revenue, topRevenue, 10);
    return (
      `${medal}  **${e.display_name}**\n` +
      `\`${bar}\`  ${money(e.total_revenue)}  ·  **${e.order_count}** orders`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle("🏆  WEEKLY LEADERBOARD  ·  TOKYO DRIFT CUSTOMS")
    .setColor(COLORS.gold)
    .setDescription(
      `**Week of ${label}**\n\n` +
      rows.join("\n\n")
    );

  // Leader callout
  if (entries.length >= 1) {
    const top = entries[0];
    embed.addFields({
      name: "👑  This Week's Leader",
      value: `**${top.display_name}** is running the board with **${money(top.total_revenue)}** across **${top.order_count}** orders. Keep it up! 🔥`,
      inline: false,
    });
  }

  embed
    .setFooter({ text: "東京ドリフトカスタム  ·  Resets every Monday  ·  Last updated" })
    .setTimestamp(updatedAt);

  return embed;
}

function buildBar(value: number, max: number, width: number): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function getWeekStart(): string {
  const { start } = getWeekBounds();
  return start.toISOString().slice(0, 10);
}
