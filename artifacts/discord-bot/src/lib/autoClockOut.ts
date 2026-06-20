import { Client, TextChannel } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { buildClockOutEmbed } from "./embeds.js";

const IDLE_MINUTES = 20;

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoClockOutMonitor(client: Client) {
  if (timer) clearInterval(timer);
  // Check every 5 minutes
  timer = setInterval(() => checkIdleMechanics(client), 5 * 60 * 1000);
  console.log("[TDC] ⏱️ Auto clock-out monitor started (idle threshold: 20 min)");
}

async function checkIdleMechanics(client: Client) {
  try {
    // Find all clocked-in mechanics
    const active = await db.execute(
      `SELECT id, mechanic_id, clock_in_time, clock_message_id, clock_channel_id
       FROM timeclock
       WHERE clock_out_time IS NULL`
    );

    for (const row of active.rows) {
      const tcId        = String(row[0] ?? "");
      const mechanicId  = String(row[1] ?? "");
      const clockInTime = String(row[2] ?? "");
      const msgId       = row[3] ? String(row[3]) : null;
      const chanId      = row[4] ? String(row[4]) : null;

      // Check if they've completed any order in the last IDLE_MINUTES
      const cutoff = new Date(Date.now() - IDLE_MINUTES * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const recent = await db.execute({
        sql: `SELECT COUNT(*) FROM orders
              WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?`,
        args: [mechanicId, cutoff]
      });
      const recentCount = Number(recent.rows[0]?.[0] ?? 0);
      if (recentCount > 0) continue; // Active — skip

      // Also check if they clocked in less than IDLE_MINUTES ago (grace period)
      const clockInMs = new Date(clockInTime).getTime();
      if (Date.now() - clockInMs < IDLE_MINUTES * 60 * 1000) continue;

      // Auto clock out
      const mins = (Date.now() - clockInMs) / 60000;
      await db.execute({
        sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved' WHERE id = ?",
        args: [mins, tcId]
      });
      await db.execute({
        sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?",
        args: [mins / 60, mechanicId]
      });

      const profile = await getProfile(mechanicId);
      const name    = profile?.display_name ?? mechanicId;
      const clockNow = new Date().toISOString().replace("T", " ").slice(0, 19);
      const embed = buildClockOutEmbed(name, clockInTime, clockNow, mins, 0);

      // Edit original clock-in message in timeclock channel
      try {
        // Find guild from timeclock channel
        let guild: any = null;
        if (chanId) {
          for (const g of client.guilds.cache.values()) {
            try {
              const ch = await g.channels.fetch(chanId).catch(() => null);
              if (ch) { guild = g; break; }
            } catch { /* skip */ }
          }
        }
        if (!guild) {
          // fallback: find first guild the bot shares with this user
          for (const g of client.guilds.cache.values()) {
            try {
              await g.members.fetch(mechanicId);
              guild = g;
              break;
            } catch { /* skip */ }
          }
        }

        if (guild && msgId && chanId) {
          try {
            const ch = await guild.channels.fetch(chanId);
            if (ch?.isTextBased()) {
              const msg = await (ch as any).messages.fetch(msgId);
              await msg.edit({ embeds: [embed] });
            }
          } catch { /* ignore */ }
        }

        // Ping in their sales channel
        if (guild) {
          const config = await getGuildConfig(guild.id);
          const salesChanId = profile?.sales_channel_id;
          if (salesChanId) {
            try {
              const ch = await guild.channels.fetch(salesChanId);
              if (ch?.isTextBased()) {
                await (ch as any).send({
                  content:
                    `⏰ <@${mechanicId}> — You've been **automatically clocked out** after ${IDLE_MINUTES} minutes of inactivity.\n` +
                    `**Shift:** ${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m\n` +
                    `If this was a mistake, clock back in from the timeclock channel.`,
                });
              }
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        console.error(`[TDC] Auto clock-out notification failed for ${mechanicId}:`, err);
      }

      console.log(`[TDC] ⏱️ Auto clocked out ${name} after ${Math.round(mins)}min of inactivity`);
    }
  } catch (err) {
    console.error("[TDC] Auto clock-out monitor error:", err);
  }
}
