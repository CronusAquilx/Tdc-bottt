import { Client, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { buildClockOutEmbed } from "./embeds.js";
import { warnedMechanics } from "./warnState.js";

const WARN_AFTER_MINS         = 120;
const AUTO_OUT_AFTER_WARN_MINS = 30;

function parseUtc(s: string): number {
  if (!s) return 0;
  const norm = s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + "Z";
  return new Date(norm).getTime();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoClockOutMonitor(client: Client) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => checkIdleMechanics(client), 5 * 60 * 1000);
  console.log("[TDC] ⏱️ Auto clock-out monitor started (warn: 30 min, auto-out: 40 min)");
}

async function checkIdleMechanics(client: Client) {
  try {
    const active = await db.execute(
      `SELECT id, mechanic_id, clock_in_time, clock_message_id, clock_channel_id, warned_at, stayed_in_at, guild_id, warn_msg_id, warn_chan_id
       FROM timeclock
       WHERE clock_out_time IS NULL`
    );

    for (const row of active.rows) {
      const tcId        = String(row[0] ?? "");
      const mechanicId  = String(row[1] ?? "");
      const clockInTime = String(row[2] ?? "");
      const msgId       = row[3] ? String(row[3]) : null;
      const chanId      = row[4] ? String(row[4]) : null;
      const warnedAtDb  = row[5] ? String(row[5]) : null;
      const stayedInDb  = row[6] ? String(row[6]) : null;
      const guildId     = row[7] ? String(row[7]) : null;
      const warnMsgId   = row[8] ? String(row[8]) : null;
      const warnChanId  = row[9] ? String(row[9]) : null;

      const clockInMs   = parseUtc(clockInTime);
      const stayedInMs  = stayedInDb ? parseUtc(stayedInDb) : 0;
      const idleStartMs = Math.max(clockInMs, stayedInMs);
      const minsIdle    = (Date.now() - idleStartMs) / 60000;

      if (minsIdle < WARN_AFTER_MINS) continue;

      let guild: any = null;
      if (guildId) {
        guild = client.guilds.cache.get(guildId) ?? null;
      }
      if (!guild && chanId) {
        for (const g of client.guilds.cache.values()) {
          try { const ch = await g.channels.fetch(chanId).catch(() => null); if (ch) { guild = g; break; } } catch { /* skip */ }
        }
      }
      if (!guild) {
        for (const g of client.guilds.cache.values()) {
          try { await g.members.fetch(mechanicId); guild = g; break; } catch { /* skip */ }
        }
      }

      const cutoffWarn = new Date(idleStartMs).toISOString().replace("T", " ").slice(0, 19);
      const recentOrders = await db.execute({
        sql: `SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?`,
        args: [mechanicId, cutoffWarn]
      });
      const recentCount = Number(recentOrders.rows[0]?.[0] ?? 0);
      const hadRecentActivity = recentCount > 0;

      const inMemory = warnedMechanics.get(tcId);
      const warnedAt = inMemory?.warnedAt ?? (warnedAtDb ? parseUtc(warnedAtDb) : null);
      const alreadyWarned = warnedAt !== null;

      if (alreadyWarned) {
        const minsSinceWarn = (Date.now() - warnedAt!) / 60000;

        if (hadRecentActivity) {
          warnedMechanics.delete(tcId);
          await db.execute({ sql: "UPDATE timeclock SET warned_at = NULL WHERE id = ?", args: [tcId] });
          continue;
        }

        if (minsSinceWarn >= AUTO_OUT_AFTER_WARN_MINS) {
          await autoClockOut(client, guild, tcId, mechanicId, clockInTime, msgId, chanId);

          // Clean up the warning message buttons so it can't be clicked after auto-clock-out
          const resolvedWarnMsgId  = inMemory?.msgId  ?? warnMsgId;
          const resolvedWarnChanId = inMemory?.chanId ?? warnChanId;
          if (resolvedWarnMsgId && resolvedWarnChanId && guild) {
            try {
              const warnCh = await guild.channels.fetch(resolvedWarnChanId).catch(() => null);
              if (warnCh?.isTextBased()) {
                const warnMsg = await (warnCh as any).messages.fetch(resolvedWarnMsgId).catch(() => null);
                if (warnMsg) {
                  await warnMsg.edit({
                    content: `⏱️ <@${mechanicId}> was automatically clocked out after inactivity.`,
                    components: []
                  });
                }
              }
            } catch { /* ignore */ }
          }

          warnedMechanics.delete(tcId);
        }
        continue;
      }

      if (hadRecentActivity) continue;

      await sendIdleWarning(client, guild, tcId, mechanicId, chanId);
    }
  } catch (err) {
    console.error("[TDC] Auto clock-out monitor error:", err);
  }
}

async function sendIdleWarning(
  client: Client, guild: any, tcId: string, mechanicId: string, tcChanId: string | null
) {
  try {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`clockwarn:stayin:${tcId}`)
        .setLabel("✅  Stay Clocked In")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`clockwarn:clockout:${tcId}`)
        .setLabel("🔴  Clock Out Now")
        .setStyle(ButtonStyle.Danger)
    );

    let warned = false;

    if (guild) {
      const profile = await getProfile(mechanicId);
      if (profile?.sales_channel_id) {
        try {
          const ch = await guild.channels.fetch(profile.sales_channel_id).catch(() => null);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({
              content:
                `⚠️ <@${mechanicId}> — you've been idle for **${WARN_AFTER_MINS} minutes**.\n` +
                `You'll be **automatically clocked out** in **${AUTO_OUT_AFTER_WARN_MINS} minutes** if you don't respond.`,
              components: [row]
            });
            await db.execute({
              sql: "UPDATE timeclock SET warned_at = datetime('now'), warn_msg_id = ?, warn_chan_id = ? WHERE id = ?",
              args: [msg.id, ch.id, tcId]
            });
            warnedMechanics.set(tcId, { warnedAt: Date.now(), msgId: msg.id, chanId: ch.id, mechanicId });
            warned = true;
          }
        } catch { /* ignore */ }
      }
    }

    if (!warned) {
      try {
        const user = await client.users.fetch(mechanicId);
        const dm = await user.createDM();
        const msg = await dm.send({
          content:
            `⚠️ **Tokyo Drift Customs — Idle Warning**\n\n` +
            `You've been clocked in but idle for **${WARN_AFTER_MINS} minutes**.\n` +
            `You'll be **automatically clocked out** in **${AUTO_OUT_AFTER_WARN_MINS} minutes** if no action is taken.`,
          components: [row]
        });
        await db.execute({
          sql: "UPDATE timeclock SET warned_at = datetime('now'), warn_msg_id = ?, warn_chan_id = ? WHERE id = ?",
          args: [msg.id, dm.id, tcId]
        });
        warnedMechanics.set(tcId, { warnedAt: Date.now(), msgId: msg.id, chanId: dm.id, mechanicId });
        warned = true;
      } catch { /* DMs closed */ }
    }

    console.log(`[TDC] ⚠️ Sent idle warning to ${mechanicId} (warned: ${warned})`);
  } catch (err) {
    console.error(`[TDC] Failed to send idle warning to ${mechanicId}:`, err);
  }
}

export async function autoClockOut(
  client: Client, guild: any, tcId: string, mechanicId: string,
  clockInTime: string, msgId: string | null, chanId: string | null
) {
  const clockInMs = parseUtc(clockInTime);
  const mins = (Date.now() - clockInMs) / 60000;

  await db.execute({
    sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', warned_at = NULL, stayed_in_at = NULL, warn_msg_id = NULL, warn_chan_id = NULL WHERE id = ?",
    args: [mins, tcId]
  });
  await db.execute({
    sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?",
    args: [mins / 60, mechanicId]
  });

  const profile = await getProfile(mechanicId);
  const name    = profile?.display_name ?? mechanicId;
  const clockNow = new Date().toISOString().replace("T", " ").slice(0, 19);
  const embed   = buildClockOutEmbed(name, clockInTime, clockNow, mins, 0);

  if (guild && msgId && chanId) {
    try {
      const ch = await guild.channels.fetch(chanId).catch(() => null);
      if (ch?.isTextBased()) {
        const m = await (ch as any).messages.fetch(msgId).catch(() => null);
        if (m) await m.edit({ embeds: [embed] });
      }
    } catch { /* ignore */ }
  }

  if (guild) {
    try {
      const config    = await getGuildConfig(guild.id);
      const notifChan = config?.timeclock_channel_id;
      if (notifChan) {
        const ch = await guild.channels.fetch(notifChan).catch(() => null);
        if (ch?.isTextBased()) {
          await (ch as any).send({
            content:
              `⏰ <@${mechanicId}> — You've been **automatically clocked out** after ${Math.round(WARN_AFTER_MINS + AUTO_OUT_AFTER_WARN_MINS)} minutes of inactivity.\n` +
              `**Shift:** ${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`,
            embeds: [embed]
          });
        }
      }
    } catch { /* ignore */ }
  }

  console.log(`[TDC] ⏱️ Auto clocked out ${name} after ${Math.round(mins)}min`);
}
