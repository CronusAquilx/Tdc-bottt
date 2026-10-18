import { ChannelType, type Client, type TextChannel } from "discord.js";
import { db, getUserRole, getProfile, getGuildConfig, splitRoleIds, rowToOrder, getSetting, saveDatabaseSnapshot } from "../db.js";
import { processPayall, refreshPayLogPanel } from "../commands/payall.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import { resendOrderPanel } from "../interactions/orderpanel.js";
import { buildOrderEmbed, money } from "./embeds.js";
import { logEvent } from "./eventLog.js";
import { weekStart } from "./utils.js";
import { deliverCompletedOrder } from "./orderDelivery.js";

/** Picks the Discord server the crew is configured in (the bot may be in several). */
export async function crewGuild(client: Client) {
  for (const guild of client.guilds.cache.values()) {
    if (await getGuildConfig(guild.id)) return guild;
  }
  return client.guilds.cache.first();
}

export async function websiteIdentity(client: Client, id: string) {
  const guild = await crewGuild(client);
  const profile = await getProfile(id);
  const active = await db.execute({ sql: "SELECT terminated_at FROM profiles WHERE discord_id=?", args: [id] });
  if (!guild || !profile || !active.rows[0] || active.rows[0][0]) throw new Error("Active crew member not found");
  // Website logins use the bot's saved crew role, not a live Discord membership check.
  const role = (await getUserRole(id)) ?? "mechanic";
  return { ...profile, role };
}

export async function websiteManagement(client: Client, body: any) {
  const actor = await websiteIdentity(client, String(body.actor_id ?? ""));
  if (actor.role !== "owner" && actor.role !== "manager") throw new Error("Management role required");
  return actor;
}

export async function websiteComplete(client: Client, body: any) {
  const actor = await websiteIdentity(client, String(body.actor_id ?? ""));
  const guild = await crewGuild(client);
  if (!guild) throw new Error("Discord server unavailable");
  const id = String(body.order_id ?? "");
  const rows = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
  if (!rows.rows[0]) throw new Error("Order not found");
  const order = rowToOrder(rows.rows[0]);
  if (actor.discord_id !== order.mechanic_id && !["owner", "manager"].includes(actor.role)) throw new Error("This order belongs to another mechanic");
  if (order.status !== "draft") throw new Error("Only draft orders can be completed");
  if (!order.items.length || !order.customer_name?.trim()) throw new Error("A customer name and at least one service are required");
  const profile = await getProfile(order.mechanic_id);
  if (!profile?.sales_channel_id) throw new Error("The mechanic has no sales channel");
  const channel = await guild.channels.fetch(profile.sales_channel_id);
  if (channel?.type !== ChannelType.GuildText) throw new Error("Sales channel unavailable");
  const pay = await getCommissionData(order.mechanic_id, guild.id, order.role_level);
  const claimed = await db.execute({ sql: "UPDATE orders SET status='complete', completed_at=datetime('now') WHERE id=? AND status='draft'", args: [id] });
  if (!claimed.rowsAffected) throw new Error("Order was already completed");
  let posted = false;
  try {
    const delivered = await deliverCompletedOrder(client, guild, id);
    posted = delivered.posted || delivered.alreadyPosted;
  } catch (error) { console.error("[TDC] website order sales post failed", error); }
  const config = await getGuildConfig(guild.id);
  const logId = config?.orders_channel_id ?? config?.log_channel_id;
  if (logId && logId !== profile.sales_channel_id) {
    const log = await guild.channels.fetch(logId).catch(() => null);
    if (log?.type === ChannelType.GuildText) {
      const freshRows = await db.execute({ sql: "SELECT * FROM orders WHERE id=?", args: [id] });
      const fresh = rowToOrder(freshRows.rows[0]);
      const embed = buildOrderEmbed(fresh, profile.display_name, pay.weekCommission + (fresh.is_own_car ? 0 : Math.round(fresh.labour * pay.rate)), pay.rate);
      await log.send({ embeds: [embed] }).catch(console.error);
    }
  }
  logEvent({ kind: "order_completed", guildId: guild.id, userId: actor.discord_id, orderId: id, orderNumber: order.order_number, amount: order.labour, detail: `website; sales_posted=${posted}` });
  await saveDatabaseSnapshot(); await refreshPayLogPanel(guild);
  return { ok: true, posted };
}

export async function websitePayroll(client: Client, body: any) {
  const actor = await websiteManagement(client, body);
  const guild = await crewGuild(client);
  if (!guild) throw new Error("Discord server unavailable");
  const requestId = String(body.request_id ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid payroll request");
  const prior = await getSetting(`website_payroll_result:${requestId}`);
  if (prior) return JSON.parse(prior);
  // A durable, atomic claim serializes website payroll. On failure it stays locked
  // for manual reconciliation; never retry uncertain financial work automatically.
  const claim = await db.execute({ sql: "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('website_payroll_lock',?)", args: [requestId] });
  if (!claim.rowsAffected) throw new Error("Payroll is already running or needs management reconciliation");
  const result = await processPayall(guild, weekStart(), actor.discord_id);
  const response = { ok: true, mechanicCount: result?.mechanicCount ?? 0, totalToBill: result?.totalToBill ?? 0 };
  await db.execute({ sql: "INSERT INTO app_settings(key,value) VALUES (?,?)", args: [`website_payroll_result:${requestId}`, JSON.stringify(response)] });
  await saveDatabaseSnapshot();
  if (result) {
    for (const payout of result.payouts) {
      if (!payout.salesChanId) continue;
      const channel = await guild.channels.fetch(payout.salesChanId).catch(() => null);
      if (channel?.type !== ChannelType.GuildText) continue;
      await channel.send({ content: `<@${payout.mechanicId}>\n**Pay statement — ${payout.name}**\n${payout.orders} orders · ${payout.hours.toFixed(1)} hours\nTotal: **${money(payout.amount + payout.managerCut)}**\nCheck your pay log for payment status. New pay period started.`, allowedMentions: { users: [payout.mechanicId] } }).catch(console.error);
      await resendOrderPanel(channel as TextChannel, payout.mechanicId, payout.name, payout.rate).catch(console.error);
    }
    const config = await getGuildConfig(guild.id);
    const log = config?.payday_channel_id ? await guild.channels.fetch(config.payday_channel_id).catch(() => null) : null;
    if (log?.type === ChannelType.GuildText) await log.send(`Website payroll processed by <@${actor.discord_id}>: ${result.mechanicCount} crew · ${money(result.totalToBill)}`).catch(console.error);
  }
  await refreshPayLogPanel(guild);
  await db.execute("DELETE FROM app_settings WHERE key='website_payroll_lock'");
  await saveDatabaseSnapshot(); return response;
}

export async function websiteRemove(client: Client, body: any) {
  const actor = await websiteManagement(client, body);
  const target = await websiteIdentity(client, String(body.discord_id ?? ""));
  if (target.discord_id === actor.discord_id || target.role === "owner" || (target.role === "manager" && actor.role !== "owner")) throw new Error("You cannot remove this crew member");
  const guild = await crewGuild(client);
  if (!guild) throw new Error("Discord server unavailable");
  const config = await getGuildConfig(guild.id);
  const member = await guild.members.fetch(target.discord_id);
  const roles = [...splitRoleIds(config?.mechanic_role_id), ...splitRoleIds(config?.trainer_role_id), ...splitRoleIds(config?.manager_role_id), ...splitRoleIds((config as any)?.needs_training_role_id)];
  await member.roles.remove(roles, `Crew removed through website by ${actor.display_name}`);
  await db.execute({ sql: "UPDATE profiles SET terminated_at=datetime('now'), status='offline' WHERE discord_id=?", args: [target.discord_id] });
  await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id=?", args: [target.discord_id] });
  logEvent({ kind: "crew_changed", guildId: guild.id, userId: target.discord_id, userName: target.display_name, detail: `Removed through website by ${actor.discord_id}` });
  const log = config?.log_channel_id ? await guild.channels.fetch(config.log_channel_id).catch(() => null) : null;
  if (log?.type === ChannelType.GuildText) await log.send(`**Crew removed:** ${target.display_name} — by <@${actor.discord_id}>`).catch(console.error);
  await saveDatabaseSnapshot(); return { ok: true };
}

export async function websiteAnnounce(client: Client, body: any) {
  const actor = await websiteManagement(client, body);
  if (body.website_url !== "https://tokyomech.lovable.app") throw new Error("Invalid website address");
  const rows = await db.execute("SELECT DISTINCT sales_channel_id FROM profiles WHERE terminated_at IS NULL AND sales_channel_id IS NOT NULL");
  let sent = 0, failed = 0;
  for (const row of rows.rows) {
    try {
      const channel = await client.channels.fetch(String(row[0]));
      if (channel?.type !== ChannelType.GuildText) { failed++; continue; }
      await channel.send({ content: "**Tokyo Drift Customs — Crew website**\nOrders, weekly pay and sales: https://tokyomech.lovable.app\nUse your privately assigned crew username. Ask management privately if you need account access.", allowedMentions: { parse: [] } }); sent++;
    } catch { failed++; }
  }
  logEvent({ kind: "crew_changed", userId: actor.discord_id, detail: `Website announced: ${sent} sent, ${failed} failed` });
  return { sent, failed };
}

export async function websiteBank(client: Client, actorId: string, limit: number) {
  await websiteManagement(client, { actor_id: actorId });
  const guild = await crewGuild(client);
  if (!guild) throw new Error("Discord server unavailable");
  const result = await db.execute({ sql: "SELECT b.*, p.display_name AS logged_by_name FROM bank_account_logs b LEFT JOIN profiles p ON p.discord_id=b.logged_by WHERE b.guild_id=? ORDER BY datetime(b.logged_at) DESC LIMIT ?", args: [guild.id, limit] });
  return result.rows.map(row => Object.fromEntries(result.columns.map((key, index) => [key, typeof row[index] === "bigint" ? Number(row[index]) : row[index]])));
}
