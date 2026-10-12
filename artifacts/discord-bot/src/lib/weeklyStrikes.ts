import { Client, Guild, TextChannel } from "discord.js";
import { db, getGuildConfig, splitRoleIds } from "../db.js";
import { isUpdateEnabled } from "./featureFlags.js";
import { LOW_HOURS_STRIKE_THRESHOLD, WEEKLY_HOURS_GOAL } from "./payrollPolicy.js";
import { calculateCreditedShiftMinutes } from "./timeclock.js";

const TIME_ZONE = process.env.TDC_TIMEZONE?.trim() || "America/Chicago";
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day };
}

function dateString({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function mondayDate(date: Date): string {
  const parts = localDateParts(date);
  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
  return utcDate.toISOString().slice(0, 10);
}

function zonedMidnightUtc(localDay: string): number {
  const [year, month, day] = localDay.split("-").map(Number);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetLocalAsUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
    const representedLocalAsUtc = Date.UTC(
      values.year, values.month - 1, values.day, values.hour, values.minute, values.second,
    );
    guess += targetLocalAsUtc - representedLocalAsUtc;
  }
  return guess;
}

function parseDatabaseUtc(value: unknown): number {
  const raw = String(value ?? "");
  if (!raw) return 0;
  return new Date(raw.includes("T") || raw.endsWith("Z") ? raw : `${raw.replace(" ", "T")}Z`).getTime();
}

async function sendStrikeMessage(guild: Guild, channelId: string | null, text: string): Promise<void> {
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) await (channel as TextChannel).send({ content: text });
}

export async function evaluateWeeklyStrikes(guild: Guild, periodStart: string, periodEnd: string): Promise<void> {
  if (!(await isUpdateEnabled())) return;
  const start = zonedMidnightUtc(periodStart);
  const end = zonedMidnightUtc(periodEnd);
  const profiles = await db.execute(
    "SELECT discord_id, display_name, sales_channel_id, strike_count, terminated_at FROM profiles"
  );
  const shifts = await db.execute(
    `SELECT id, mechanic_id, clock_in_time, clock_out_time, duration_minutes, status
     FROM timeclock
     WHERE (guild_id = ? OR guild_id IS NULL OR guild_id = '')
       AND datetime(clock_in_time) < datetime(?)
       AND (clock_out_time IS NULL OR datetime(clock_out_time) > datetime(?))`,
    [guild.id, new Date(end).toISOString().replace("T", " ").slice(0, 19), new Date(start).toISOString().replace("T", " ").slice(0, 19)],
  );

  const hoursByMechanic = new Map<string, number>();
  for (const shift of shifts.rows) {
    if (String(shift[5] ?? "") === "rejected") continue;
    const shiftId = String(shift[0] ?? "");
    const mechanicId = String(shift[1] ?? "");
    const clockInTime = String(shift[2] ?? "");
    const originalStart = parseDatabaseUtc(clockInTime);
    const actualEnd = shift[3] ? parseDatabaseUtc(shift[3]) : end;
    const shiftStart = Math.max(start, originalStart);
    const shiftEnd = Math.min(end, actualEnd);
    if (shiftEnd <= shiftStart) continue;
    const eligibleAtEnd = await calculateCreditedShiftMinutes(
      shiftId, mechanicId, clockInTime, shiftEnd, true,
    );
    const eligibleAtStart = await calculateCreditedShiftMinutes(
      shiftId, mechanicId, clockInTime, shiftStart, true,
    );
    const eligibleMinutes = Math.max(0, eligibleAtEnd - eligibleAtStart);
    hoursByMechanic.set(
      mechanicId,
      (hoursByMechanic.get(mechanicId) ?? 0) + eligibleMinutes / 60,
    );
  }

  const config = await getGuildConfig(guild.id);
  const checkMessages: string[] = [];
  for (const profile of profiles.rows) {
    const mechanicId = String(profile[0] ?? "");
    const name = String(profile[1] ?? "Crew member");
    const salesChannelId = profile[2] ? String(profile[2]) : null;
    const previousStrikes = Number(profile[3] ?? 0);
    const terminated = Boolean(profile[4]);
    if (!mechanicId || terminated) continue;

    const hours = hoursByMechanic.get(mechanicId) ?? 0;
    const recorded = await db.execute({
      sql: `INSERT OR IGNORE INTO weekly_strike_checks
            (guild_id, period_start, mechanic_id, hours_worked, strike_number)
            VALUES (?, ?, ?, ?, ?)`,
      args: [guild.id, periodStart, mechanicId, hours, previousStrikes],
    });
    if (Number(recorded.rowsAffected ?? 0) === 0) continue;

    if (hours < LOW_HOURS_STRIKE_THRESHOLD) {
      const strikeNumber = previousStrikes + 1;
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      if (strikeNumber === 1) {
        await db.execute({
          sql: `UPDATE profiles SET strike_count = ?, order_hold_until = datetime('now', '+1 day')
                WHERE discord_id = ?`,
          args: [strikeNumber, mechanicId],
        });
        await sendStrikeMessage(
          guild,
          salesChannelId,
          `⚠️ <@${mechanicId}> — **Strike 1 of 3**: you worked ${hours.toFixed(2)} active hours from Monday to payday, below the 3h 30m minimum. You are on a 24-hour hold from starting cars. Reach 5 hours next pay period.`,
        );
        checkMessages.push(`${name}: strike 1, 24-hour order hold`);
      } else if (strikeNumber === 2) {
        await db.execute({
          sql: `UPDATE profiles SET strike_count = ?, strike_pay_cut_pending = 1
                WHERE discord_id = ?`,
          args: [strikeNumber, mechanicId],
        });
        await sendStrikeMessage(
          guild,
          salesChannelId,
          `⚠️ <@${mechanicId}> — **Strike 2 of 3**: you again worked ${hours.toFixed(2)} active hours, below 3h 30m. Your next processed paycheck will be reduced by 50%. No additional customer-debt deduction applies.`,
        );
        checkMessages.push(`${name}: strike 2, next paycheck halved`);
      } else {
        await db.execute({
          sql: `UPDATE profiles SET strike_count = ?, terminated_at = ?, status = 'offline'
                WHERE discord_id = ?`,
          args: [strikeNumber, now, mechanicId],
        });
        const member = await guild.members.fetch(mechanicId).catch(() => null);
        for (const roleId of splitRoleIds(config?.mechanic_role_id)) {
          if (member?.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, "Third weekly-hours strike").catch(() => null);
          }
        }
        await sendStrikeMessage(
          guild,
          salesChannelId,
          `⚠️ <@${mechanicId}> — **Strike 3 of 3**: you worked ${hours.toFixed(2)} active hours, below 3h 30m again. Your shop profile is now terminated and you can no longer start orders.`,
        );
        checkMessages.push(`${name}: strike 3, terminated`);
      }
    } else if (hours < WEEKLY_HOURS_GOAL) {
      await sendStrikeMessage(
        guild,
        salesChannelId,
        `⏱️ <@${mechanicId}> — you worked ${hours.toFixed(2)} active hours this pay period. You avoided a strike by reaching 3h 30m, but the weekly goal is 5 hours.`,
      );
    }
  }

  if (checkMessages.length && config?.log_channel_id) {
    await sendStrikeMessage(
      guild,
      config.log_channel_id,
      `📋 **Weekly hours and strike check** (${periodStart} to ${periodEnd})\n${checkMessages.join("\n")}`,
    );
  }
  console.log(`[TDC] Weekly strike check completed for ${guild.id}: ${periodStart}–${periodEnd}`);
}

export async function latestCheckedHours(guildId: string, mechanicId: string, fallback: number): Promise<number> {
  const result = await db.execute({
    sql: `SELECT hours_worked FROM weekly_strike_checks
          WHERE guild_id = ? AND mechanic_id = ?
          ORDER BY period_start DESC LIMIT 1`,
    args: [guildId, mechanicId],
  });
  return result.rows[0] ? Number(result.rows[0][0] ?? fallback) : fallback;
}

export function startWeeklyStrikeChecks(client: Client): void {
  const tick = async () => {
    const now = new Date();
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const weekday = local.find(part => part.type === "weekday")?.value;
    const hour = Number(local.find(part => part.type === "hour")?.value ?? -1);
    const minute = Number(local.find(part => part.type === "minute")?.value ?? -1);
    if (weekday !== "Mon" || hour !== 0 || minute >= 5 || !(await isUpdateEnabled())) return;

    const currentMonday = mondayDate(now);
    const previous = new Date(`${currentMonday}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 7);
    const previousMonday = previous.toISOString().slice(0, 10);
    const configs = await db.execute("SELECT guild_id FROM guild_config");
    for (const row of configs.rows) {
      const guildId = String(row[0] ?? "");
      if (!guildId) continue;
      try {
        const guild = await client.guilds.fetch(guildId);
        await evaluateWeeklyStrikes(guild, previousMonday, currentMonday);
      } catch (error) {
        console.error(`[TDC] Weekly strike check failed for ${guildId}:`, error);
      }
    }
  };
  setInterval(() => tick().catch(error => console.error("[TDC] Weekly strike scheduler error:", error)), 60_000);
  console.log(`[TDC] Weekly strike check scheduler started (${TIME_ZONE}, Monday to Monday)`);
}
