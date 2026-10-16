/**
 * Small helpers that make order-building survive flaky connections.
 *
 *  - withRetry:      retry transient network / Discord 5xx failures
 *  - withOrderLock:  run order edits one at a time per order, so a double-fired
 *                    select (slow connection, user clicking twice) can't
 *                    overwrite itself or lose items
 *  - safeEditReply:  edit the interaction reply, retrying, and fall back to
 *                    editing the message directly if the interaction token fails
 */

import { logError } from "./eventLog.js";

const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ConnectTimeoutError", "SQLITE_BUSY", "SQLITE_LOCKED",
]);

// Discord errors where retrying can never help.
const PERMANENT_DISCORD_CODES = new Set([10062, 10008, 10003, 40060, 50001, 50013, 50035]);

export function isTransientError(err: unknown): boolean {
  const e = err as any;
  const code = e?.code ?? e?.rawError?.code ?? e?.cause?.code;
  if (typeof code === "number" && PERMANENT_DISCORD_CODES.has(code)) return false;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const status = e?.status ?? e?.httpStatus;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  const msg = String(e?.message ?? "").toLowerCase();
  return /fetch failed|network|socket|timed? ?out|timeout|econn|temporar|try again|stream|busy|locked/.test(msg);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !isTransientError(err)) throw err;
      await new Promise(res => setTimeout(res, baseMs * attempt));
    }
  }
  throw lastErr;
}

const locks = new Map<string, Promise<unknown>>();

export async function withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(orderId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  locks.set(orderId, run);
  try {
    return await run;
  } finally {
    if (locks.get(orderId) === run) locks.delete(orderId);
  }
}

/** Edit the reply to a component interaction without losing the update on a bad connection. */
export async function safeEditReply(interaction: any, payload: any): Promise<void> {
  try {
    await withRetry(() => interaction.editReply(payload), { tries: 3, baseMs: 500 });
    return;
  } catch (err) {
    if (isDeadInteraction(err) || !interaction.message?.edit) {
      logError("editReply", err, { guildId: interaction.guildId, userId: interaction.user?.id, command: interaction.customId });
      return;
    }
    // Interaction token trouble — edit the message itself instead.
    try {
      const { content, embeds, components } = payload;
      await withRetry(() => interaction.message.edit({ content, embeds, components }), { tries: 2 });
    } catch (err2) {
      logError("editReply-fallback", err2, { guildId: interaction.guildId, userId: interaction.user?.id, command: interaction.customId });
    }
  }
}

function isDeadInteraction(err: unknown): boolean {
  const code = (err as any)?.code ?? (err as any)?.rawError?.code;
  return code === 10062 || code === 40060;
}

/** Acknowledge a component interaction, retrying once if the connection hiccups. */
export async function safeDeferUpdate(interaction: any): Promise<void> {
  await withRetry(() => interaction.deferUpdate(), { tries: 2, baseMs: 200 });
}
