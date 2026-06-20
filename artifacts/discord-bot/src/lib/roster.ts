import { EmbedBuilder } from "discord.js";
import { COLORS } from "./embeds.js";

export type RosterMember = {
  discord_id: string;
  display_name: string;
  rank: string;
  status: string;
  hours_this_week: number;
  is_on_loa: boolean;
  loa_return?: string | null;
};

const RANK_EMOJI: Record<string, string> = {
  owner:    "👑",
  manager:  "🔧",
  trainer:  "📚",
  mechanic: "🔩",
};

const RANK_ORDER: Record<string, number> = {
  owner: 4, manager: 3, trainer: 2, mechanic: 1,
};

const STATUS_ICON: Record<string, string> = {
  online:   "🟢",
  on_break: "🟡",
  offline:  "⚫",
};

export function buildRosterEmbed(members: RosterMember[], refreshedAt: Date): EmbedBuilder {
  const sorted = [...members].sort((a, b) =>
    (RANK_ORDER[b.rank] ?? 0) - (RANK_ORDER[a.rank] ?? 0) ||
    a.display_name.localeCompare(b.display_name)
  );

  const byRank: Record<string, RosterMember[]> = {};
  for (const m of sorted) {
    const r = m.rank ?? "mechanic";
    if (!byRank[r]) byRank[r] = [];
    byRank[r].push(m);
  }

  const online  = members.filter(m => m.status === "online").length;
  const onBreak = members.filter(m => m.status === "on_break").length;
  const onLoa   = members.filter(m => m.is_on_loa).length;

  const embed = new EmbedBuilder()
    .setTitle("👥  TOKYO DRIFT CUSTOMS  ·  CREW ROSTER")
    .setColor(COLORS.primary)
    .setDescription(
      `🟢 **${online}** online  ·  🟡 **${onBreak}** on break  ·  🌴 **${onLoa}** on LOA  ·  👥 **${members.length}** total\n` +
      `\`\`\`\n東京ドリフトカスタム  ·  Built Different. Driven Hard.\n\`\`\``
    );

  const rankOrder = ["owner", "manager", "trainer", "mechanic"];
  for (const rank of rankOrder) {
    const group = byRank[rank];
    if (!group?.length) continue;

    const lines = group.map(m => {
      const statusIcon = m.is_on_loa ? "🌴" : (STATUS_ICON[m.status] ?? "⚫");
      const loaNote    = m.is_on_loa && m.loa_return ? ` *(back <t:${Math.floor(new Date(m.loa_return).getTime() / 1000)}:R>)*` : "";
      const hrs        = m.hours_this_week > 0 ? `  ·  ${m.hours_this_week.toFixed(1)}h` : "";
      return `${statusIcon} **${m.display_name}**${hrs}${loaNote}`;
    });

    const rankLabel = rank.charAt(0).toUpperCase() + rank.slice(1) + "s";
    embed.addFields({
      name:   `${RANK_EMOJI[rank] ?? "🔹"}  ${rankLabel} (${group.length})`,
      value:  lines.join("\n").slice(0, 1024),
      inline: false,
    });
  }

  const ts = Math.floor(refreshedAt.getTime() / 1000);
  embed.setFooter({ text: `東京ドリフトカスタム  ·  Auto-refreshes every 5 min  ·  Last update` });
  embed.setTimestamp(refreshedAt);

  return embed;
}
