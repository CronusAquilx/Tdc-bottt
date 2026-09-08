/**
 * Persistent append-only event log — survives bot restarts.
 * Each event is a single JSON line written to data/events.jsonl
 * This gives you a human-readable audit trail of everything that happened.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = process.env.TDC_DATA_DIR?.trim()
  ? path.resolve(process.env.TDC_DATA_DIR.trim())
  : path.join(__dirname, "..", "..", "data");
const LOG_FILE  = path.join(DATA_DIR, "events.jsonl");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export type EventKind =
  | "order_created"
  | "order_completed"
  | "order_cancelled"
  | "order_paid"
  | "clock_in"
  | "clock_out"
  | "payout_processed"
  | "new_week"
  | "loa_submitted"
  | "loa_approved"
  | "loa_denied";

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

/** Append a structured event to the JSON log file (non-blocking). */
export function logEvent(event: LogEvent): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  fs.appendFile(LOG_FILE, entry, (err) => {
    if (err) console.error("[TDC] ⚠️ Failed to write event log:", err);
  });
}

/** Read the last N events from the log (for admin review). */
export function readRecentEvents(count = 50): LogEvent[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-count);
    return lines.map(l => JSON.parse(l) as LogEvent);
  } catch {
    return [];
  }
}
