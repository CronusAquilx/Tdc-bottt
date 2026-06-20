import { Client, TextChannel } from "discord.js";
import { db, getGuildConfig } from "../db.js";
import { buildRosterEmbed } from "./roster.js";

let rosterTimer: ReturnType<typeof setInterval> | null = null;

export function startRosterAutoRefresh(client: Client) {
  if (rosterTimer) clearInterval(rosterTimer);
  rosterTimer = setInterval(() => refreshAllRosters(client), 5 * 60 * 1000);
  console.log("[TDC] 📋 Roster auto-refresh started (every 5 min)");
}

export async function refreshAllRosters(client: Client) {
  try {
    const rows = await db.execute("SELECT guild_id, roster_channel_id FROM guild_config WHERE roster_channel_id IS NOT NULL");
    for (const row of rows.rows) {
      const guildId   = String(row[0] ?? "");
      const channelId = row[1] ? String(row[1]) : null;
      if (!guildId || !channelId) continue;
      try {
        const guild = await client.guilds.fetch(guildId);
        const ch    = await guild.channels.fetch(channelId).catch(() => null);
        if (!ch?.isTextBased()) continue;
        await postOrUpdateRoster(ch as TextChannel);
      } catch (err) {
        console.error(`[TDC] Roster refresh failed for guild ${guildId}:`, err);
      }
    }
  } catch (err) {
    console.error("[TDC] Roster auto-refresh error:", err);
  }
}

export async function postOrUpdateRoster(channel: TextChannel) {
  const members = await fetchRosterMembers();
  const embed   = buildRosterEmbed(members, new Date());

  // Try to find existing roster message to edit
  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = [...recent.values()].find(m =>
      m.author.bot && m.embeds[0]?.title?.includes("CREW ROSTER")
    );
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  } catch { /* fallthrough */ }

  await channel.send({ embeds: [embed] });
}

async function fetchRosterMembers() {
  const r = await db.execute(`
    SELECT
      p.discord_id,
      p.display_name,
      ur.role,
      p.status,
      p.hours_worked_this_week,
      CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END as is_on_loa,
      l.return_date
    FROM profiles p
    JOIN user_roles ur ON ur.discord_id = p.discord_id
    LEFT JOIN loa_requests l ON l.mechanic_id = p.discord_id
      AND l.status = 'approved'
      AND l.return_date >= date('now')
    ORDER BY
      CASE ur.role
        WHEN 'owner'    THEN 1
        WHEN 'manager'  THEN 2
        WHEN 'trainer'  THEN 3
        WHEN 'mechanic' THEN 4
        ELSE 5
      END,
      p.display_name
  `);

  // De-dup by discord_id (keep highest rank)
  const seen = new Map<string, any>();
  for (const row of r.rows) {
    const id = String(row[0] ?? "");
    if (!seen.has(id)) seen.set(id, row);
  }

  return [...seen.values()].map(row => ({
    discord_id:      String(row[0] ?? ""),
    display_name:    String(row[1] ?? ""),
    rank:            String(row[2] ?? "mechanic"),
    status:          String(row[3] ?? "offline"),
    hours_this_week: Number(row[4] ?? 0),
    is_on_loa:       Number(row[5] ?? 0) === 1,
    loa_return:      row[6] ? String(row[6]) : null,
  }));
}
