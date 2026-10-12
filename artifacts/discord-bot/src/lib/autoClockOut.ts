import { Client, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { buildClockOutEmbed } from "./embeds.js";
import { warnedMechanics } from "./warnState.js";
import { isUpdateEnabled } from "./featureFlags.js";
import { calculateCreditedShiftMinutes } from "./timeclock.js";

const AUTO_OUT_AFTER_WARN_MINS = 15;

function parseUtc(s: string): number {
  if (!s) return 0;
  const norm = s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + "Z";
  return new Date(norm).getTime();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoClockOutMonitor(client: Client) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => checkIdleMechanics(client), 60 * 1000);
  console.log("[TDC] ⏱️ Idle monitor started (5-minute legacy checks; 30-minute staged checks)");
}

async function checkIdleMechanics(client: Client) {
  try {
    const updateEnabled = await isUpdateEnabled();
    if (!updateEnabled && new Date().getMinutes() % 5 !== 0) return;
    const warnAfterMins = updateEnabled ? 30 : 45;
    const active = await db.execute(
      `SELECT id, mechanic_id, clock_in_time, clock_message_id, clock_channel_id, warned_at, stayed_in_at, guild_id, warn_msg_id, warn_chan_id, last_idle_ping_at
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
      const lastPingRaw = row[10] ? String(row[10]) : null;

      const clockInMs   = parseUtc(clockInTime);
      const stayedInMs  = stayedInDb ? parseUtc(stayedInDb) : 0;
      let lastOrderMs = 0;
      if (updateEnabled) {
        const lastOrderR = await db.execute({
          sql: `SELECT MAX(completed_at) FROM orders
                WHERE mechanic_id = ? AND completed_at IS NOT NULL
                  AND datetime(completed_at) >= datetime(?)`,
          args: [mechanicId, clockInTime],
        });
        lastOrderMs = lastOrderR.rows[0]?.[0] ? parseUtc(String(lastOrderR.rows[0][0])) : 0;
      }
      const idleStartMs = Math.max(clockInMs, stayedInMs, lastOrderMs);
      const minsIdle    = (Date.now() - idleStartMs) / 60000;

      if (minsIdle < warnAfterMins) {
        const previousWarn = warnedAtDb ? parseUtc(warnedAtDb) : 0;
        if (previousWarn && idleStartMs > previousWarn) {
          warnedMechanics.delete(tcId);
          await db.execute({
            sql: "UPDATE timeclock SET warned_at = NULL, warn_msg_id = NULL, warn_chan_id = NULL WHERE id = ?",
            args: [tcId],
          });
        }
        continue;
      }

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

      const inMemory = warnedMechanics.get(tcId);
      const warnedAt = inMemory?.warnedAt ?? (warnedAtDb ? parseUtc(warnedAtDb) : null);
      const alreadyWarned = warnedAt !== null;
      if (!updateEnabled) {
        const cutoffWarn = new Date(idleStartMs).toISOString().replace("T", " ").slice(0, 19);
        const recentOrders = await db.execute({
          sql: `SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?`,
          args: [mechanicId, cutoffWarn],
        });
        if (Number(recentOrders.rows[0]?.[0] ?? 0) > 0) {
          if (alreadyWarned) {
            warnedMechanics.delete(tcId);
            await db.execute({ sql: "UPDATE timeclock SET warned_at = NULL WHERE id = ?", args: [tcId] });
          }
          continue;
        }
      }

      if (alreadyWarned) {
        const minsSinceWarn = (Date.now() - warnedAt!) / 60000;

        if (minsSinceWarn >= AUTO_OUT_AFTER_WARN_MINS) {
          await autoClockOut(client, guild, tcId, mechanicId, clockInTime, msgId, chanId, warnAfterMins);

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

      const lastPingMs = lastPingRaw ? parseUtc(lastPingRaw) : 0;
      if (updateEnabled && lastPingMs >= idleStartMs && Date.now() - lastPingMs < warnAfterMins * 60_000) {
        continue;
      }
      await sendIdleWarning(client, guild, tcId, mechanicId, chanId, warnAfterMins);
    }
  } catch (err) {
    console.error("[TDC] Auto clock-out monitor error:", err);
  }
}

async function sendIdleWarning(
  client: Client, guild: any, tcId: string, mechanicId: string, tcChanId: string | null, warnAfterMins: number
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
                `⚠️ <@${mechanicId}> — you've been idle for **${warnAfterMins} minutes**.\n` +
                `You'll be **automatically clocked out** in **${AUTO_OUT_AFTER_WARN_MINS} minutes** if you don't respond.`,
              components: [row]
            });
            await db.execute({
              sql: "UPDATE timeclock SET warned_at = datetime('now'), last_idle_ping_at = datetime('now'), warn_msg_id = ?, warn_chan_id = ? WHERE id = ?",
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
            `You've been clocked in but idle for **${warnAfterMins} minutes**.\n` +
            `You'll be **automatically clocked out** in **${AUTO_OUT_AFTER_WARN_MINS} minutes** if no action is taken.`,
          components: [row]
        });
        await db.execute({
          sql: "UPDATE timeclock SET warned_at = datetime('now'), last_idle_ping_at = datetime('now'), warn_msg_id = ?, warn_chan_id = ? WHERE id = ?",
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
  clockInTime: string, msgId: string | null, chanId: string | null, warnAfterMins = 45
) {
  const mins = await calculateCreditedShiftMinutes(tcId, mechanicId, clockInTime);

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
              `⏰ <@${mechanicId}> — You've been **automatically clocked out** after ${Math.round(warnAfterMins + AUTO_OUT_AFTER_WARN_MINS)} minutes of inactivity.\n` +
              `**Shift:** ${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`,
            embeds: [embed]
          });
        }
      }
    } catch { /* ignore */ }
  }

  console.log(`[TDC] ⏱️ Auto clocked out ${name} after ${Math.round(mins)}min`);
}
