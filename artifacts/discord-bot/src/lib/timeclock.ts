import { db } from "../db.js";
import { isUpdateEnabled } from "./featureFlags.js";

const IDLE_CREDIT_LIMIT_MS = 30 * 60 * 1000;
const IDLE_CONFIRMATION_GRACE_MS = 45 * 60 * 1000;

function parseUtc(value: string): number {
  if (!value) return 0;
  const normalized = value.includes("T") || value.endsWith("Z")
    ? value
    : `${value.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

function sqliteUtc(value: number): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

/** Calculates paid minutes from clock-in through a point in time. Orders and
 * persisted "Stay Clocked In" confirmations establish activity. Long gaps that
 * have no confirmation are capped at the 30-minute reminder threshold. */
export async function calculateCreditedShiftMinutes(
  timeclockId: string,
  mechanicId: string,
  clockInTime: string,
  throughMs = Date.now(),
  updateEnabled?: boolean,
): Promise<number> {
  const startMs = parseUtc(clockInTime);
  const endMs = Math.max(startMs, throughMs);
  if (!Number.isFinite(startMs) || startMs <= 0 || endMs <= startMs) return 0;

  const staged = updateEnabled ?? await isUpdateEnabled();
  if (!staged) return (endMs - startMs) / 60_000;

  const [ordersResult, confirmationsResult] = await Promise.all([
    db.execute({
      sql: `SELECT completed_at FROM orders
            WHERE mechanic_id = ?
              AND completed_at IS NOT NULL
              AND datetime(completed_at) >= datetime(?)
              AND datetime(completed_at) <= datetime(?)
            ORDER BY datetime(completed_at)`,
      args: [mechanicId, sqliteUtc(startMs), sqliteUtc(endMs)],
    }),
    db.execute({
      sql: `SELECT confirmed_at FROM timeclock_confirmations
            WHERE timeclock_id = ?
              AND datetime(confirmed_at) > datetime(?)
              AND datetime(confirmed_at) <= datetime(?)
            ORDER BY datetime(confirmed_at)`,
      args: [timeclockId, sqliteUtc(startMs), sqliteUtc(endMs)],
    }),
  ]);

  const activityEvents = [
    ...ordersResult.rows.map(row => ({
      at: parseUtc(String(row[0] ?? "")),
      type: "order" as const,
    })),
    ...confirmationsResult.rows.map(row => ({
      at: parseUtc(String(row[0] ?? "")),
      type: "confirmation" as const,
    })),
  ].filter(event => event.at > startMs && event.at <= endMs)
    .sort((left, right) => left.at - right.at);

  let cursorMs = startMs;
  let creditedMs = 0;
  for (const event of activityEvents) {
    const gapMs = Math.max(0, event.at - cursorMs);
    creditedMs += gapMs <= IDLE_CONFIRMATION_GRACE_MS
      ? gapMs
      : IDLE_CREDIT_LIMIT_MS;
    cursorMs = Math.max(cursorMs, event.at);
  }
  const finalGapMs = Math.max(0, endMs - cursorMs);
  creditedMs += Math.min(finalGapMs, IDLE_CREDIT_LIMIT_MS);

  return creditedMs / 60_000;
}
