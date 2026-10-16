/**
 * Manager alerts for error spikes.
 *
 * logError() reports every recorded error here. If too many arrive inside a
 * short window, managers get ONE alert in the log channel (pinging the
 * owner / head manager / manager roles), then alerts are muted for a cooldown
 * so a long outage doesn't spam the channel.
 *
 * Tunable with env vars:
 *   TDC_ERROR_ALERT_THRESHOLD   errors in the window that trigger an alert (default 5)
 *   TDC_ERROR_ALERT_WINDOW_MIN  window length in minutes (default 5)
 *   TDC_ERROR_ALERT_COOLDOWN_MIN  minutes between alerts (default 30)
 *
 * Never throws — alerting must not be able to break the bot.
 */

import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db, getGuildConfig, splitRoleIds } from "../db.js";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const THRESHOLD   = num(process.env.TDC_ERROR_ALERT_THRESHOLD, 5);
const WINDOW_MS   = num(process.env.TDC_ERROR_ALERT_WINDOW_MIN, 5) * 60_000;
const COOLDOWN_MS = num(process.env.TDC_ERROR_ALERT_COOLDOWN_MIN, 30) * 60_000;

interface RecentError { at: number; scope: string; message: string; command?: string | null }

let client: Client | null = null;
let recent: RecentError[] = [];
let lastAlertAt = 0;
let sending = false;

export function initManagerAlerts(c: Client): void {
  client = c;
}

/** Called by logError for every error that gets recorded. */
export function noteError(scope: string, message: string, command?: string | null): void {
  try {
    const now = Date.now();
    recent.push({ at: now, scope, message, command });
    recent = recent.filter(e => now - e.at <= WINDOW_MS);
    if (recent.length < THRESHOLD) return;
    if (sending || now - lastAlertAt < COOLDOWN_MS) return;
    lastAlertAt = now;
    const snapshot = [...recent];
    recent = [];
    sendAlert(snapshot).catch(err => console.error("[TDC] ⚠️ Manager alert failed:", err));
  } catch { /* never throw from alerting */ }
}

async function sendAlert(errors: RecentError[]): Promise<void> {
  if (!client?.isReady()) return;
  sending = true;
  try {
    // Group identical problems so the alert shows what is actually breaking.
    const groups = new Map<string, { count: number; scope: string; message: string; command?: string | null }>();
    for (const e of errors) {
      const key = `${e.scope}|${e.command ?? ""}|${e.message.slice(0, 80)}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { count: 1, scope: e.scope, message: e.message, command: e.command });
    }
    const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    const minutes = Math.round(WINDOW_MS / 60_000);

    const embed = new EmbedBuilder()
      .setTitle("🚨 Error spike detected")
      .setColor(0xed4245)
      .setDescription(
        `**${errors.length} errors** in the last ~${minutes} minutes.\n\n` +
        top.map(g =>
          `**${g.count}×** \`${g.scope}\`${g.command ? ` · \`${g.command.slice(0, 40)}\`` : ""}\n${g.message.slice(0, 160)}`
        ).join("\n\n").slice(0, 3800)
      )
      .setFooter({ text: "Run /auditlog errors for the full list" })
      .setTimestamp();

    const rows = await db.execute("SELECT guild_id FROM guild_config");
    for (const row of rows.rows) {
      const guildId = String(row[0] ?? "");
      if (!guildId) continue;
      try {
        const guild = await client.guilds.fetch(guildId);
        const config = await getGuildConfig(guildId);
        const roleIds = [
          ...splitRoleIds(config?.owner_role_id),
          ...splitRoleIds(config?.head_manager_role_id),
          ...splitRoleIds(config?.manager_role_id),
        ];
        const content = roleIds.length ? roleIds.map(id => `<@&${id}>`).join(" ") : undefined;

        let delivered = false;
        const channelId = config?.log_channel_id;
        if (channelId) {
          const ch = await guild.channels.fetch(channelId).catch(() => null);
          if (ch?.isTextBased()) {
            await (ch as TextChannel).send({
              content,
              embeds: [embed],
              allowedMentions: { roles: roleIds },
            });
            delivered = true;
          }
        }

        if (!delivered) {
          // No log channel configured — DM owners/managers instead.
          const staff = await db.execute("SELECT DISTINCT discord_id FROM user_roles WHERE role IN ('owner','manager')");
          for (const s of staff.rows) {
            const user = await client.users.fetch(String(s[0])).catch(() => null);
            await user?.send({ embeds: [embed] }).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[TDC] ⚠️ Could not deliver error alert for guild ${guildId}:`, err);
      }
    }
  } finally {
    sending = false;
  }
}
