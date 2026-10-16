/**
 * Persistent audit + error logging.
 *
 * Every event is written to TWO places:
 *   1. The `audit_log` / `error_log` tables in tdc.db (queryable, indexed,
 *      included in the rotating database snapshots).
 *   2. data/events.jsonl (append-only text file, rotated at 5 MB) as a
 *      human-readable fallback if the database is ever unavailable.
 *
 * Logging must NEVER break the feature that called it, so every function here
 * swallows its own failures.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../db.js";
import { noteError } from "./managerAlerts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = process.env.TDC_DATA_DIR?.trim()
  ? path.resolve(process.env.TDC_DATA_DIR.trim())
  : path.join(__dirname, "..", "..", "data");
const LOG_FILE  = path.join(DATA_DIR, "events.jsonl");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export type EventKind =
  | "order_created"
  | "order_completed"
  | "order_cancelled"
  | "order_paid"
  | "clock_in"
  | "clock_out"
  | "auto_clock_out"
  | "payout_processed"
  | "pay_adjusted"
  | "new_week"
  | "loa_submitted"
  | "loa_approved"
  | "loa_denied"
  | "crew_changed"
  | "config_changed"
  | "panels_refreshed"
  | "database_event";

export interface LogEvent {
  ts?: string;         // ISO-8601 timestamp — auto-set by logEvent if omitted
  kind: EventKind;
  guildId?: string;
  userId?: string;
  userName?: string;
  orderId?: string;
  orderNumber?: string;
  amount?: number;
  detail?: string;
}

function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); // keeps exactly one older file
  } catch { /* non-fatal */ }
}

function appendLine(obj: unknown): void {
  rotateIfNeeded();
  fs.appendFile(LOG_FILE, JSON.stringify(obj) + "\n", (err) => {
    if (err) console.error("[TDC] ⚠️ Failed to write event log file:", err);
  });
}

/** Record an audit event (non-blocking, never throws). */
export function logEvent(event: LogEvent): void {
  const entry = { ts: new Date().toISOString(), ...event };
  appendLine(entry);
  db.execute({
    sql: `INSERT INTO audit_log (ts, kind, guild_id, user_id, user_name, order_id, order_number, amount, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.ts, entry.kind,
      entry.guildId ?? null, entry.userId ?? null, entry.userName ?? null,
      entry.orderId ?? null, entry.orderNumber ?? null,
      entry.amount ?? null, entry.detail ?? null,
    ],
  }).catch(err => console.error("[TDC] ⚠️ Failed to write audit_log row:", err));
}

export interface ErrorContext {
  guildId?: string | null;
  userId?: string | null;
  command?: string | null;   // slash command name or button/modal customId
}

/** Record an error with context (non-blocking, never throws). */
export function logError(scope: string, err: unknown, ctx: ErrorContext = {}): void {
  const e = err as any;
  const message = String(e?.message ?? err ?? "unknown error").slice(0, 1000);
  const stack = typeof e?.stack === "string" ? e.stack.slice(0, 4000) : null;
  const code = e?.code ?? e?.rawError?.code ?? null;
  const ts = new Date().toISOString();
  appendLine({ ts, kind: "error", scope, message, code, ...ctx });
  noteError(scope, message, ctx.command);
  db.execute({
    sql: `INSERT INTO error_log (ts, scope, message, code, stack, guild_id, user_id, command)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [ts, scope, message, code != null ? String(code) : null, stack,
           ctx.guildId ?? null, ctx.userId ?? null, ctx.command ?? null],
  }).catch(() => { /* never recurse on logging failures */ });
}

export interface AuditRow {
  ts: string; kind: string; userName: string | null; userId: string | null;
  orderNumber: string | null; amount: number | null; detail: string | null;
}

/** Latest audit rows, optionally filtered by kind / user. Newest first. */
export async function getRecentAudit(
  opts: { guildId?: string; kind?: string; userId?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.guildId) { where.push("(guild_id = ? OR guild_id IS NULL)"); args.push(opts.guildId); }
  if (opts.kind)    { where.push("kind = ?");    args.push(opts.kind); }
  if (opts.userId)  { where.push("user_id = ?"); args.push(opts.userId); }
  args.push(Math.min(Math.max(opts.limit ?? 15, 1), 50));
  const r = await db.execute({
    sql: `SELECT ts, kind, user_name, user_id, order_number, amount, detail
          FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY id DESC LIMIT ?`,
    args,
  });
  return r.rows.map(row => ({
    ts: String(row[0]), kind: String(row[1]),
    userName: row[2] ? String(row[2]) : null, userId: row[3] ? String(row[3]) : null,
    orderNumber: row[4] ? String(row[4]) : null,
    amount: row[5] != null ? Number(row[5]) : null,
    detail: row[6] ? String(row[6]) : null,
  }));
}

export interface ErrorRow { ts: string; scope: string; message: string; command: string | null; }

export async function getRecentErrors(limit = 10): Promise<ErrorRow[]> {
  const r = await db.execute({
    sql: "SELECT ts, scope, message, command FROM error_log ORDER BY id DESC LIMIT ?",
    args: [Math.min(Math.max(limit, 1), 25)],
  });
  return r.rows.map(row => ({
    ts: String(row[0]), scope: String(row[1]), message: String(row[2]),
    command: row[3] ? String(row[3]) : null,
  }));
}

/** Keep the log tables from growing forever: audit 180 days, errors 30 days. */
export async function pruneLogs(): Promise<void> {
  try {
    await db.execute("DELETE FROM audit_log WHERE ts < datetime('now', '-180 days')");
    await db.execute("DELETE FROM error_log WHERE ts < datetime('now', '-30 days')");
  } catch (err) {
    console.error("[TDC] ⚠️ Log prune failed:", err);
  }
}
