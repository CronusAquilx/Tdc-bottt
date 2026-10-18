import { ChannelType, EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { db, getUserRole, getProfile, getGuildConfig, splitRoleIds, rowToOrder, getSetting, saveDatabaseSnapshot } from "../db.js";
import { processPayall, refreshPayLogPanel } from "../commands/payall.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import { resendOrderPanel } from "../interactions/orderpanel.js";
import { buildOrderEmbed, COLORS, money } from "./embeds.js";
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
  if (actor.role !== "owner" && actor.role !== "head_manager" && actor.role !== "manager") throw new Error("Management role required");
  return actor;
}

export async function websiteComplete(client: Client, body: any) {
  const portalActor = body.portal_actor;
  const actor = portalActor && typeof portalActor === "object"
    ? {
        discord_id: String(portalActor.discord_id ?? `portal:${portalActor.id ?? "unknown"}`),
        display_name: String(portalActor.username ?? "Website account"),
        role: String(portalActor.role ?? "mechanic"),
      }
    : await websiteIdentity(client, String(body.actor_id ?? ""));
  const guild = await crewGuild(client);
  if (!guild) throw new Error("Discord server unavailable");
  const id = String(body.order_id ?? "");
  const rows = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
  if (!rows.rows[0]) throw new Error("Order not found");
  const order = rowToOrder(rows.rows[0]);
  if (actor.discord_id !== order.mechanic_id && !["owner", "head_manager", "manager"].includes(actor.role)) throw new Error("This order belongs to another mechanic");
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

export async function websiteSetPay(client: Client, body: any) {
  const id = String(body.discord_id ?? "");
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const commission = num(body.commission);
  const managerCut = num(body.manager_cut);
  const commissionRate = num(body.commission_rate);
  const managerRate = num(body.manager_rate);
  for (const [k, v, max] of [["commission", commission, Infinity], ["manager_cut", managerCut, Infinity], ["commission_rate", commissionRate, 1], ["manager_rate", managerRate, 100]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > max)) throw new Error(`Invalid ${k}`);
  }
  if ([commission, managerCut, commissionRate, managerRate].every(v => v === null)) throw new Error("Nothing to change");
  const profile = await getProfile(id);
  if (!profile) throw new Error("Crew member not found");
  if (managerCut !== null || managerRate !== null) {
    const role = await getUserRole(id);
    if (role !== "manager" && role !== "owner") throw new Error("Manager cut only applies to managers/owners");
  }
  const updates: string[] = [];
  const args: (string | number)[] = [];
  if (commission !== null) {
    const s = await db.execute({ sql: `SELECT COALESCE(SUM(labour),0) FROM orders WHERE mechanic_id = ? AND ${"status IN ('complete', 'approved', 'paid')"} AND COALESCE(is_own_car,0)=0 AND datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`, args: [id] });
    updates.push("commission_adjustment = ?", "commission_labour_snapshot = ?");
    args.push(commission, Number(s.rows[0]?.[0] ?? 0));
  }
  if (managerCut !== null) {
    const s = await db.execute({ sql: `SELECT COALESCE(SUM(labour),0) FROM orders WHERE status IN ('complete', 'approved', 'paid') AND datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01')) AND COALESCE(is_own_car,0)=0 AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`, args: [id] });
    updates.push("manager_cut_adjustment = ?", "manager_labour_snapshot = ?");
    args.push(managerCut, Number(s.rows[0]?.[0] ?? 0));
  }
  if (commissionRate !== null) { updates.push("commission_rate = ?"); args.push(commissionRate); }
  if (managerRate !== null) { updates.push("manager_override_rate = ?"); args.push(managerRate / 100); }
  args.push(id);
  await db.execute({ sql: `UPDATE profiles SET ${updates.join(", ")} WHERE discord_id = ?`, args });
  await saveDatabaseSnapshot();
  const actorId = String(body.actor_id ?? "website");
  const actorName = String(body.actor_name ?? "website");
  logEvent({ kind: "pay_adjusted", userId: actorId, userName: actorName, amount: commission ?? undefined, detail: `web: target ${id} ${JSON.stringify({ commission, managerCut, commissionRate, managerRate })}` });

  const lines: string[] = [];
  if (commission !== null) lines.push(`> Weekly commission: **${money(commission)}**`);
  if (managerCut !== null) lines.push(`> Manager cut this week: **${money(managerCut)}**`);
  if (commissionRate !== null) lines.push(`> Commission rate: **${(commissionRate * 100).toFixed(0)}%**`);
  if (managerRate !== null) lines.push(`> Manager crew-cut rate: **${managerRate.toFixed(1)}%**`);
  const embed = new EmbedBuilder()
    .setTitle("Pay Updated (Website)")
    .setColor(COLORS.approved)
    .setDescription(`<@${id}> — ${profile.display_name}\n${lines.join("\n")}`)
    .setTimestamp();
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (config?.log_channel_id) {
        const ch = await guild.channels.fetch(config.log_channel_id).catch(() => null);
        if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
      }
      if (profile.sales_channel_id) {
        const sc = await guild.channels.fetch(profile.sales_channel_id).catch(() => null);
        if (sc?.type === ChannelType.GuildText) {
          const fresh = await getProfile(id);
          await resendOrderPanel(sc as TextChannel, id, profile.display_name, fresh?.commission_rate ?? profile.commission_rate);
        }
      }
    } catch (err) { console.error("[TDC] web setPay discord sync failed:", err); }
  }
  return { ok: true };
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
