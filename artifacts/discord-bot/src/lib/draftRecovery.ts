/**
 * Self-healing for the order panel.
 *
 * Every button / select on a draft order panel carries the draft's id in its
 * customId. If that draft can't be found any more (database restored or reset,
 * a second bot instance with its own database answered first, the draft was
 * cleared by a pay-period reset, a stale panel from yesterday, ...) the panel
 * used to dead-end with "That order no longer exists."
 *
 * resolveDraftId() instead:
 *   1. returns the id unchanged if the order exists and is still a draft,
 *   2. otherwise resumes the mechanic's newest open draft,
 *   3. otherwise creates a fresh draft (keeping the customer name shown on the panel),
 * so the click that triggered it keeps working.
 */

import { db, nextOrderNumber } from "../db.js";
import { detectUserRoleLevel } from "./roles.js";
import { randomUUID } from "./utils.js";
import { logEvent, logError } from "./eventLog.js";

function customerNameFromPanel(interaction: any): string {
  try {
    const content: string = interaction.message?.content ?? "";
    const m = content.match(/Customer:?\**\s*\**\s*([^\n*]+)/i);
    if (m?.[1]) return m[1].trim().slice(0, 100);
    const embedDesc: string = interaction.message?.embeds?.[0]?.description ?? "";
    const m2 = embedDesc.match(/Customer:?\**\s*\**\s*([^\n*]+)/i);
    if (m2?.[1]) return m2[1].trim().slice(0, 100);
  } catch { /* best effort */ }
  return "";
}

/** Who should own a recovered draft: the clicker, or the sales-channel owner when a manager is acting on their behalf. */
async function resolveMechanic(interaction: any): Promise<{ mechanicId: string; roleLevel: string }> {
  const clickerId: string = interaction.user.id;
  let roleLevel = "mechanic";
  try { roleLevel = await detectUserRoleLevel(interaction); } catch { /* default */ }
  let mechanicId = clickerId;
  if ((roleLevel === "manager" || roleLevel === "owner") && interaction.channelId) {
    try {
      const own = await db.execute({ sql: "SELECT sales_channel_id FROM profiles WHERE discord_id = ?", args: [clickerId] });
      const ownChannel = own.rows[0]?.[0] ? String(own.rows[0][0]) : null;
      if (interaction.channelId !== ownChannel) {
        const owner = await db.execute({
          sql: "SELECT discord_id FROM profiles WHERE sales_channel_id = ? LIMIT 1",
          args: [interaction.channelId],
        });
        if (owner.rows[0]?.[0]) mechanicId = String(owner.rows[0][0]);
      }
    } catch { /* keep clicker */ }
  }
  return { mechanicId, roleLevel: mechanicId === clickerId ? roleLevel : "mechanic" };
}

export async function resolveDraftId(interaction: any, orderId: string): Promise<string> {
  try {
    if (orderId) {
      const hit = await db.execute({ sql: "SELECT status FROM orders WHERE id = ?", args: [orderId] });
      if (hit.rows[0]) return orderId; // exists — let the caller handle its status as before
    }

    const guildId: string = interaction.guildId ?? "";
    const { mechanicId, roleLevel } = await resolveMechanic(interaction);

    const existing = await db.execute({
      sql: `SELECT id FROM orders WHERE mechanic_id = ? AND status = 'draft'
            AND (guild_id = ? OR guild_id = '')
            ORDER BY created_at DESC LIMIT 1`,
      args: [mechanicId, guildId],
    });
    if (existing.rows[0]) {
      const id = String(existing.rows[0][0]);
      console.warn(`[TDC] ♻️ Order ${orderId || "(none)"} not found — resumed open draft ${id} for ${mechanicId}`);
      return id;
    }

    const newId = randomUUID();
    const customer = customerNameFromPanel(interaction);
    let orderNumber = await nextOrderNumber();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.execute({
          sql: "INSERT INTO orders (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes, role_level, customer_name, is_own_car) VALUES (?, ?, ?, ?, 'draft', '[]', 0, 0, 0, '', ?, ?, 0)",
          args: [newId, orderNumber, mechanicId, guildId, roleLevel, customer],
        });
        break;
      } catch (err: any) {
        if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" && attempt < 4) {
          orderNumber = await nextOrderNumber();
          continue;
        }
        throw err;
      }
    }
    console.warn(`[TDC] ♻️ Order ${orderId || "(none)"} not found — created replacement draft ${newId} (${orderNumber}) for ${mechanicId}`);
    logEvent({ kind: "order_created", guildId, userId: mechanicId, userName: interaction.user.username, orderId: newId, orderNumber, detail: "auto-recovered missing draft" });
    return newId;
  } catch (err) {
    logError("draft-recovery", err, { guildId: interaction.guildId, userId: interaction.user?.id, command: interaction.customId });
    return orderId;
  }
}
