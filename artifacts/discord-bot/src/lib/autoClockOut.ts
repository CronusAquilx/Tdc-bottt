import { Client, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { buildClockOutEmbed } from "./embeds.js";
import { warnedMechanics, stayedIn } from "./warnState.js";

const WARN_AFTER_MINS   = 30;  // send warning after 30 min of inactivity
const AUTO_OUT_AFTER_WARN_MINS = 10; // auto clock-out 10 min after warning if no response

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoClockOutMonitor(client: Client) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => checkIdleMechanics(client), 5 * 60 * 1000);
  console.log("[TDC] ⏱️ Auto clock-out monitor started (warn: 30 min, auto-out: 40 min)");
}

async function checkIdleMechanics(client: Client) {
  try {
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

      const clockInMs = new Date(clockInTime).getTime();

      // Resolve guild
      let guild: any = null;
      if (chanId) {
        for (const g of client.guilds.cache.values()) {
          try { const ch = await g.channels.fetch(chanId).catch(() => null); if (ch) { guild = g; break; } } catch { /* skip */ }
        }
      }
      if (!guild) {
        for (const g of client.guilds.cache.values()) {
          try { await g.members.fetch(mechanicId); guild = g; break; } catch { /* skip */ }
        }
      }

      // Last real activity: most recent completed order OR last "stay in" click
      const cutoffWarn   = new Date(Date.now() - WARN_AFTER_MINS   * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const recentOrders = await db.execute({
        sql: `SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'complete' AND completed_at >= ?`,
        args: [mechanicId, cutoffWarn]
      });
      const recentCount = Number(recentOrders.rows[0]?.[0] ?? 0);
      const lastStay    = stayedIn.get(mechanicId) ?? 0;
      const lastStayMinsAgo = (Date.now() - lastStay) / 60000;
      const hadRecentActivity = recentCount > 0 || lastStayMinsAgo < WARN_AFTER_MINS;
      const minsClocked = (Date.now() - clockInMs) / 60000;

      // Grace period: don't touch people clocked in < WARN_AFTER_MINS ago
      if (minsClocked < WARN_AFTER_MINS) {
        continue;
      }

      const alreadyWarned = warnedMechanics.get(tcId);

      // ── If already warned ──────────────────────────────────────────────────
      if (alreadyWarned) {
        const minsSinceWarn = (Date.now() - alreadyWarned.warnedAt) / 60000;

        // Had activity after warning → cancel warning
        if (hadRecentActivity) {
          warnedMechanics.delete(tcId);
          continue;
        }

        // No response in AUTO_OUT_AFTER_WARN_MINS → auto clock out
        if (minsSinceWarn >= AUTO_OUT_AFTER_WARN_MINS) {
          await autoClockOut(client, guild, tcId, mechanicId, clockInTime, msgId, chanId);
          warnedMechanics.delete(tcId);
        }
        continue;
      }

      // ── Not yet warned ─────────────────────────────────────────────────────
      if (hadRecentActivity) continue; // still active

      // Send warning
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

    // Send warning in mechanic's personal sales channel first
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
            warnedMechanics.set(tcId, { warnedAt: Date.now(), msgId: msg.id, chanId: ch.id, mechanicId });
            warned = true;
          }
        } catch { /* ignore */ }
      }
    }

    // Fallback: DM the mechanic if no sales channel
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
  const clockInMs = new Date(clockInTime).getTime();
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
  const embed   = buildClockOutEmbed(name, clockInTime, clockNow, mins, 0);

  // Edit original clock-in message
  if (guild && msgId && chanId) {
    try {
      const ch = await guild.channels.fetch(chanId).catch(() => null);
      if (ch?.isTextBased()) {
        const m = await (ch as any).messages.fetch(msgId).catch(() => null);
        if (m) await m.edit({ embeds: [embed] });
      }
    } catch { /* ignore */ }
  }

  // Notify in timeclock channel
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
