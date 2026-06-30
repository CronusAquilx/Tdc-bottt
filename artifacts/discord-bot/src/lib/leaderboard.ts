import { EmbedBuilder } from "discord.js";
import { COLORS } from "./embeds.js";

export type LeaderEntry = {
  discord_id: string;
  display_name: string;
  order_count: number;
  total_revenue: number;
};

const PLACE_ICONS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

function buildBar(value: number, max: number, width = 12): string {
  if (max === 0) return "░".repeat(width);
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function getWeekBounds(): { start: Date; end: Date; label: string } {
  const now   = new Date();
  const day   = now.getUTCDay();
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
  const embed = new EmbedBuilder()
    .setTitle("🏆  ALL-TIME LEADERBOARD  ·  TOKYO DRIFT CUSTOMS")
    .setColor(COLORS.gold);

  if (!entries.length) {
    embed
      .setDescription(
        "## All-Time Customer Revenue\n\n" +
        "```\n  No completed orders yet.\n  Get to work! 🔧\n```"
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  All completed orders  ·  Last updated" })
      .setTimestamp(updatedAt);
    return embed;
  }

  const topRev = entries[0]!.total_revenue;

  const topSection = entries.slice(0, 3).map((e, i) => {
    const bar   = buildBar(e.total_revenue, topRev, 14);
    const place = PLACE_ICONS[i] ?? `${i + 1}.`;
    return `${place}  **${e.display_name}**\n` +
           `\`${bar}\`  **${money(e.total_revenue)}**  ·  ${e.order_count} orders`;
  }).join("\n\n");

  const restSection = entries.slice(3).map((e, i) => {
    const bar   = buildBar(e.total_revenue, topRev, 8);
    const place = PLACE_ICONS[i + 3] ?? `${i + 4}.`;
    return `${place}  **${e.display_name}**  \`${bar}\`  ${money(e.total_revenue)}  ·  ${e.order_count} orders`;
  }).join("\n");

  embed.setDescription(
    "## All-Time Customer Revenue\n\n" +
    topSection +
    (restSection ? `\n\n${restSection}` : "")
  );

  const leader = entries[0]!;
  const runnerUp = entries[1];
  const gap = runnerUp ? `  ·  **${money(leader.total_revenue - runnerUp.total_revenue)}** ahead of 2nd` : "";
  embed.addFields({
    name: "👑  ALL-TIME LEADER",
    value: `**${leader.display_name}** — ${money(leader.total_revenue)} across **${leader.order_count}** orders${gap} 🔥`,
    inline: false,
  });

  const totalOrders = entries.reduce((s, e) => s + e.order_count, 0);
  const totalRev    = entries.reduce((s, e) => s + e.total_revenue, 0);
  embed.addFields(
    { name: "📋 Total Orders", value: `**${totalOrders}**`,      inline: true },
    { name: "💰 Total Revenue",  value: `**${money(totalRev)}**`, inline: true },
    { name: "👥 Mechanics",      value: `**${entries.length}**`,  inline: true },
  );

  embed
    .setFooter({ text: "東京ドリフトカスタム  ·  All completed orders  ·  Last updated" })
    .setTimestamp(updatedAt);

  return embed;
}

export function getWeekStart(): string {
  const now   = new Date();
  const day   = now.getUTCDay();
  const diff  = day === 0 ? -6 : 1 - day;
  const d     = new Date(now);
  d.setUTCDate(now.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}
