import { ChannelType, type Client, type Guild, type TextChannel } from "discord.js";
import { db, getProfile, rowToOrder } from "../db.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import { buildCompletedOrderRow } from "../interactions/orderpanel.js";
import { buildOrderEmbed } from "./embeds.js";
import { logError } from "./eventLog.js";

/**
 * Deliver a completed order once. If Discord accepted the message but the
 * database update failed, the next attempt finds the existing order post by
 * its unique order number instead of sending a duplicate.
 */
export async function deliverCompletedOrder(
  client: Client,
  guild: Guild,
  orderId: string,
): Promise<{ posted: boolean; alreadyPosted: boolean }> {
  const result = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
  if (!result.rows[0]) throw new Error("Order no longer exists");
  const order = rowToOrder(result.rows[0]);
  if (!["complete", "approved", "paid"].includes(order.status)) {
    throw new Error("Only completed orders can be posted to sales");
  }
  if (order.discord_message_id) return { posted: false, alreadyPosted: true };

  const profile = await getProfile(order.mechanic_id);
  if (!profile?.sales_channel_id) throw new Error("Mechanic has no sales channel configured");
  const channel = await guild.channels.fetch(profile.sales_channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error("Mechanic sales channel is unavailable");

  const botId = client.user?.id;
  const recentMessages = await (channel as TextChannel).messages.fetch({ limit: 100 }).catch(() => null);
  const priorMessage = botId && recentMessages
    ? [...recentMessages.values()].find(message =>
        message.author.id === botId &&
        message.embeds.some(embed => embed.title?.includes(order.order_number))
      )
    : undefined;

  if (priorMessage) {
    await db.execute({
      sql: "UPDATE orders SET discord_message_id = ? WHERE id = ? AND discord_message_id IS NULL",
      args: [priorMessage.id, orderId],
    });
    return { posted: false, alreadyPosted: true };
  }

  const commission = await getCommissionData(order.mechanic_id, guild.id, order.role_level);
  const crewCutInfo = commission.crewCut > 0 || ["trainer", "manager", "owner"].includes(order.role_level)
    ? { amount: commission.crewCut, rate: commission.crewCutRate, label: commission.crewCutLabel }
    : undefined;
  const embed = buildOrderEmbed(
    order,
    profile.display_name,
    commission.weekCommission,
    commission.rate,
    crewCutInfo,
  );
  const message = await (channel as TextChannel).send({
    embeds: [embed],
    components: [await buildCompletedOrderRow(order.mechanic_id)],
  });
  await db.execute({
    sql: "UPDATE orders SET discord_message_id = ? WHERE id = ? AND discord_message_id IS NULL",
    args: [message.id, orderId],
  });
  return { posted: true, alreadyPosted: false };
}

export async function retryRecentOrderDeliveries(client: Client, guild: Guild): Promise<number> {
  const pending = await db.execute({
    sql: `SELECT id FROM orders
          WHERE status IN ('complete', 'approved', 'paid')
            AND (guild_id = ? OR guild_id = '')
            AND discord_message_id IS NULL
            AND completed_at >= datetime('now', '-7 days')
          ORDER BY datetime(completed_at) ASC
          LIMIT 25`,
    args: [guild.id],
  });

  let delivered = 0;
  for (const row of pending.rows) {
    const orderId = String(row[0] ?? "");
    if (!orderId) continue;
    try {
      const result = await deliverCompletedOrder(client, guild, orderId);
      if (result.posted || result.alreadyPosted) delivered++;
    } catch (error) {
      logError("order-delivery-retry", error, { guildId: guild.id, command: "order-delivery-retry" });
    }
  }
  return delivered;
}
