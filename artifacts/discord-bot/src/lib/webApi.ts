// Private HTTP API used by the TDC dashboard website.
// Every request must send header `x-api-key: <WEB_API_SECRET>`.
import type { IncomingMessage, ServerResponse } from "http";
import { ChannelType, type Client, type TextChannel } from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import { handlePortalApi } from "./portalApi.js";
import { websiteIdentity, websiteManagement, websiteComplete, websitePayroll, websiteRemove, websiteAnnounce, websiteBank, websiteSetPay } from "./websiteActions.js";

const SINCE_RESET_SQL =
  "datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))";
const DONE_STATUSES = "status IN ('complete', 'approved', 'paid')";

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 100_000) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function rowsToObjects(r: { columns: string[]; rows: any[] }) {
  return r.rows.map(row => {
    const o: Record<string, unknown> = {};
    r.columns.forEach((c, i) => { const v = row[i]; o[c] = typeof v === "bigint" ? Number(v) : v; });
    return o;
  });
}

function primaryGuildId(client: Client): string {
  return client.guilds.cache.first()?.id ?? "";
}

async function crew(client: Client) {
  const guildId = primaryGuildId(client);
  const r = await db.execute(
    `SELECT p.discord_id, p.display_name, p.sales_channel_id, p.commission_rate, p.manager_override_rate,
            p.hours_worked_this_week, p.status, p.commission_adjustment, p.manager_cut_adjustment,
            p.current_pay_status, p.terminated_at,
            (SELECT role FROM user_roles ur WHERE ur.discord_id = p.discord_id LIMIT 1) AS role
     FROM profiles p WHERE p.terminated_at IS NULL ORDER BY p.display_name`
  );
  const people = rowsToObjects(r as any);
  const out = [];
  for (const p of people) {
    const role = String(p.role ?? "mechanic");
    const pay = await getCommissionData(String(p.discord_id), guildId, role).catch(() => null);
    const lab = await db.execute({
      sql: `SELECT COALESCE(SUM(labour),0), COUNT(*) FROM orders WHERE mechanic_id = ? AND ${DONE_STATUSES} AND COALESCE(is_own_car,0)=0 AND ${SINCE_RESET_SQL}`,
      args: [String(p.discord_id)],
    });
    out.push({
      ...p,
      role,
      week_labour: Number(lab.rows[0]?.[0] ?? 0),
      week_orders: Number(lab.rows[0]?.[1] ?? 0),
      effective_rate: pay?.rate ?? Number(p.commission_rate ?? 0.3),
      week_commission: pay?.weekCommission ?? 0,
      crew_cut: pay?.crewCut ?? 0,
      crew_cut_rate: pay?.crewCutRate ?? 0,
      total_pay: (pay?.weekCommission ?? 0) + (pay?.crewCut ?? 0),
    });
  }
  return out;
}

async function orders(limit: number, mechanicId?: string | null) {
  const r = await db.execute({
    sql: `SELECT o.id, o.order_number, o.mechanic_id, p.display_name AS mechanic_name, o.status, o.items,
                 o.total, o.labour, o.parts_cost, o.customer_name, o.notes, o.role_level, o.is_own_car,
                 o.created_at, o.completed_at, o.approved_by
          FROM orders o LEFT JOIN profiles p ON p.discord_id = o.mechanic_id
          ${mechanicId ? "WHERE o.mechanic_id = ?" : ""}
          ORDER BY datetime(o.created_at) DESC LIMIT ?`,
    args: mechanicId ? [mechanicId, limit] : [limit],
  });
  return rowsToObjects(r as any).map(o => {
    let items: unknown = [];
    try { items = JSON.parse(String(o.items ?? "[]")); } catch { /* ignore */ }
    return { ...o, items };
  });
}

async function payouts(limit: number) {
  const r = await db.execute({
    sql: `SELECT y.id, y.mechanic_id, p.display_name AS mechanic_name, y.week_start, y.amount, y.manager_cut,
                 y.hourly_pay, y.order_count, y.hours_worked, y.paid_at, y.paid_by, y.created_at
          FROM payouts y LEFT JOIN profiles p ON p.discord_id = y.mechanic_id
          ORDER BY datetime(COALESCE(y.paid_at, y.created_at)) DESC LIMIT ?`,
    args: [limit],
  });
  return rowsToObjects(r as any);
}

async function salesChannel(client: Client, mechanicId: string) {
  const profile = await getProfile(mechanicId);
  if (!profile?.sales_channel_id) return { messages: [] };
  const ch = await client.channels.fetch(profile.sales_channel_id).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return { messages: [] };
  const msgs = await (ch as TextChannel).messages.fetch({ limit: 30 });
  return {
    channel_name: (ch as TextChannel).name,
    messages: [...msgs.values()].map(m => ({
      id: m.id,
      author: m.member?.displayName ?? m.author.username,
      is_bot: m.author.bot,
      content: m.content,
      created_at: m.createdAt.toISOString(),
      embeds: m.embeds.map(e => ({
        title: e.title, description: e.description,
        fields: e.fields.map(f => ({ name: f.name, value: f.value })),
      })),
    })),
  };
}

/** Returns true if the request was handled. */
export async function handleWebApi(req: IncomingMessage, res: ServerResponse, client: Client): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  const secret = process.env.WEB_API_SECRET;
  if (!secret || req.headers["x-api-key"] !== secret) { send(res, 401, { error: "Unauthorized" }); return true; }
  if (url.pathname.startsWith("/api/portal/")) {
    await handlePortalApi(req, res, client);
    return true;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/identity") return send(res, 200, await websiteIdentity(client, String(url.searchParams.get("discord_id") ?? ""))), true;
    if (req.method === "POST" && url.pathname === "/api/orders/complete") return send(res, 200, await websiteComplete(client, await readJson(req))), true;
    if (req.method === "POST" && url.pathname === "/api/payroll") return send(res, 200, await websitePayroll(client, await readJson(req))), true;
    if (req.method === "POST" && url.pathname === "/api/crew/remove") return send(res, 200, await websiteRemove(client, await readJson(req))), true;
    if (req.method === "POST" && url.pathname === "/api/announce") return send(res, 200, await websiteAnnounce(client, await readJson(req))), true;
    if (req.method === "GET" && url.pathname === "/api/bank-logs") return send(res, 200, await websiteBank(client, String(req.headers["x-user-discord-id"] ?? ""), 200)), true;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    if (req.method === "GET" && url.pathname === "/api/crew") return send(res, 200, await crew(client)), true;
    if (req.method === "GET" && url.pathname === "/api/orders") return send(res, 200, await orders(limit, url.searchParams.get("mechanic_id"))), true;
    if (req.method === "GET" && url.pathname === "/api/payouts") return send(res, 200, await payouts(limit)), true;
    if (req.method === "GET" && url.pathname === "/api/sales-channel") return send(res, 200, await salesChannel(client, String(url.searchParams.get("mechanic_id") ?? ""))), true;
    if (req.method === "POST" && url.pathname === "/api/pay") {
      const body = await readJson(req); await websiteManagement(client, body);
      return send(res, 200, await websiteSetPay(client, body)), true;
    }
    send(res, 404, { error: "Not found" });
  } catch (err: any) {
    send(res, 400, { error: String(err?.message ?? err) });
  }
  return true;
}
