import { EmbedBuilder } from "discord.js";
import { COLORS } from "./embeds.js";

export type LeaderEntry = {
  discord_id: string;
  display_name: string;
  order_count: number;
  total_revenue: number;
  total_labour: number;
  commission_rate: number;
};

const PLACE_ICONS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "11.", "12.", "13.", "14.", "15."];

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

export function buildLeaderboardEmbed(entries: LeaderEntry[], updatedAt: Date): EmbedBuilder {
  const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  const embed = new EmbedBuilder()
    .setTitle("🏆  REVENUE LEADERBOARD  ·  TOKYO DRIFT CUSTOMS")
    .setColor(COLORS.gold);

  if (!entries.length) {
    embed
      .setDescription(
        `${DIVIDER}\n\n` +
        "```\n  No completed orders yet.\n  Get to work! 🔧\n```\n\n" +
        `🔄 Last updated: <t:${Math.floor(updatedAt.getTime() / 1000)}:R>`
      )
      .setFooter({ text: "東京ドリフトカスタム  ·  All-time customer revenue" })
      .setTimestamp(updatedAt);
    return embed;
  }

  // Sort by revenue (highest first) — caller already sorts, but ensure it here too
  const sorted = [...entries].sort((a, b) => b.total_revenue - a.total_revenue);
  const topRevenue = sorted[0]!.total_revenue;

  // Top 3 — big with progress bars
  const topSection = sorted.slice(0, 3).map((e, i) => {
    const bar   = buildBar(e.total_revenue, topRevenue, 16);
    const place = PLACE_ICONS[i]!;
    return (
      `${place}  **${e.display_name}**\n` +
      `\`${bar}\`\n` +
      `> 💰 **${money(e.total_revenue)}** revenue  ·  📋 **${e.order_count}** order${e.order_count !== 1 ? "s" : ""}`
    );
  }).join("\n\n");

  // Positions 4–15 — compact single-line
  const restSection = sorted.slice(3).map((e, i) => {
    const bar   = buildBar(e.total_revenue, topRevenue, 8);
    const place = PLACE_ICONS[i + 3] ?? `${i + 4}.`;
    return `${place}  **${e.display_name}**  \`${bar}\`  ${money(e.total_revenue)}  ·  ${e.order_count} orders`;
  }).join("\n");

  const nowTs = Math.floor(updatedAt.getTime() / 1000);

  embed.setDescription(
    `${DIVIDER}\n\n` +
    topSection +
    (restSection ? `\n\n${restSection}` : "") +
    `\n\n${DIVIDER}\n🔄 Last updated: <t:${nowTs}:R>`
  );

  // Leader callout
  const leader   = sorted[0]!;
  const runnerUp = sorted[1];
  const gap      = runnerUp
    ? `  ·  **${money(leader.total_revenue - runnerUp.total_revenue)}** ahead of 2nd place`
    : "";
  embed.addFields({
    name:   "👑  CURRENT LEADER",
    value:  `**${leader.display_name}** — **${money(leader.total_revenue)}** brought in for the shop across **${leader.order_count}** orders${gap} 🔥`,
    inline: false,
  });

  const totalOrders  = sorted.reduce((s, e) => s + e.order_count, 0);
  const totalRevenue = sorted.reduce((s, e) => s + e.total_revenue, 0);
  embed.addFields(
    { name: "📋 Total Orders",          value: `**${totalOrders}**`,          inline: true },
    { name: "💰 Total Revenue for Shop", value: `**${money(totalRevenue)}**`,  inline: true },
  );

  embed
    .setFooter({ text: "東京ドリフトカスタム  ·  All-time customer revenue  ·  Auto-updates on every completed order" })
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
