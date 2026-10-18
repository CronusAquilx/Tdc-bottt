import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import {
  db,
  getProfile,
  getGuildConfig,
  getUserRole,
  getSetting,
  nextOrderNumber,
  saveDatabaseSnapshot,
  splitRoleIds,
} from "../db.js";
import { buildClockOutEmbed, buildLoaEmbed } from "./embeds.js";
import { logEvent } from "./eventLog.js";
import { calculateCreditedShiftMinutes } from "./timeclock.js";
import { warnedMechanics, stayedIn } from "./warnState.js";
import {
  buildBankLogEmbed,
  buildBankPaidComponents,
  recordBankBalance,
  resetBankBaseline,
} from "../interactions/bankaccount.js";
import { isUpdateEnabled } from "./featureFlags.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import { withOrderLock } from "./resilience.js";
import {
  crewGuild,
  websiteComplete,
  websitePayroll,
  websiteSetPay,
} from "./websiteActions.js";

type PortalRole = "owner" | "head_manager" | "manager" | "trainer" | "mechanic";
export type PortalAccount = {
  id: string;
  username: string;
  role: PortalRole;
  active: boolean;
};

type AccountRow = {
  id: string;
  username: string;
  username_key: string;
  role: string;
  password_hash: string | null;
  password_salt: string | null;
  active: number | boolean;
};

class PortalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const COOKIE_NAME = "tdc_portal_session";
const SESSION_DAYS = 7;
const SETUP_HOURS = 72;
const allowedRoles = new Set<PortalRole>([
  "owner",
  "head_manager",
  "manager",
  "trainer",
  "mechanic",
]);
const loginAttempts = new Map<string, { count: number; since: number }>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = chunk as Buffer;
    size += data.length;
    if (size > 32_000) throw new PortalError(413, "Request body is too large");
    chunks.push(data);
  }
  try {
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new PortalError(400, "Invalid JSON request body");
  }
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw new PortalError(400, "Username is required");
  const username = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!username || username.length > 64 || /[\u0000-\u001f]/.test(username)) {
    throw new PortalError(400, "Username must be 1–64 characters");
  }
  return username;
}

function usernameKey(username: string): string {
  return username.toLocaleLowerCase("en-US");
}

function parseRole(value: unknown): PortalRole {
  if (typeof value !== "string" || !allowedRoles.has(value as PortalRole)) {
    throw new PortalError(400, "Invalid account role");
  }
  return value as PortalRole;
}

function toAccount(row: AccountRow): PortalAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    role: parseRole(row.role),
    active: Number(row.active) === 1,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

async function passwordHash(password: string): Promise<{ salt: string; hash: string }> {
  if (password.length < 12 || password.length > 256) {
    throw new PortalError(400, "Password must be between 12 and 256 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = (await derivePassword(password, salt)).toString("hex");
  return { salt, hash };
}

async function readAccountByUsername(username: string): Promise<AccountRow | null> {
  const result = await db.execute({
    sql: "SELECT id, username, username_key, role, password_hash, password_salt, active FROM portal_accounts WHERE username_key=?",
    args: [usernameKey(username)],
  });
  return (result.rows[0] as unknown as AccountRow | undefined) ?? null;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function currentAccount(req: IncomingMessage): Promise<PortalAccount | null> {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (!token) return null;
  const result = await db.execute({
    sql: `SELECT a.id, a.username, a.username_key, a.role, a.password_hash, a.password_salt, a.active
          FROM portal_sessions s
          JOIN portal_accounts a ON a.id=s.account_id
          WHERE s.token_hash=? AND datetime(s.expires_at)>datetime('now') AND a.active=1`,
    args: [hashToken(token)],
  });
  const row = result.rows[0] as unknown as AccountRow | undefined;
  return row ? toAccount(row) : null;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string): void {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = process.env.NODE_ENV === "production" || forwardedProto === "https";
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = process.env.NODE_ENV === "production" || forwardedProto === "https";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

async function startSession(
  req: IncomingMessage,
  res: ServerResponse,
  account: PortalAccount,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db.execute({
    sql: "INSERT INTO portal_sessions (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    args: [id, account.id, hashToken(token), expires],
  });
  setSessionCookie(req, res, token);
}

async function sessionResponse(req: IncomingMessage): Promise<{ initialized: boolean; account: PortalAccount | null }> {
  const count = await db.execute("SELECT COUNT(*) FROM portal_accounts");
  return {
    initialized: Number(count.rows[0]?.[0] ?? 0) > 0,
    account: await currentAccount(req),
  };
}

function setupOrigin(req: IncomingMessage): string {
  const configured = process.env.PORTAL_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
        throw new Error("Production portal URL must use HTTPS");
      }
      return url.origin;
    } catch {
      throw new PortalError(503, "PORTAL_BASE_URL must be a valid website origin");
    }
  }

  const forwarded = req.headers["x-portal-origin"];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (process.env.NODE_ENV !== "production" && candidate) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      const trusted = host === "localhost" || host === "127.0.0.1" || host.endsWith(".replit.dev") || host.endsWith(".repl.co");
      if (trusted && (url.protocol === "https:" || host === "localhost" || host === "127.0.0.1")) {
        return url.origin;
      }
    } catch {
      // Fall through to the explicit configuration error.
    }
  }
  throw new PortalError(503, "Portal invite links are not configured. Set PORTAL_BASE_URL to the website origin.");
}

function setupUrl(origin: string, token: string): string {
  return `${origin}/staff/activate?token=${encodeURIComponent(token)}`;
}

async function issueSetupToken(accountId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SETUP_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db.execute({
    sql: "UPDATE portal_setup_tokens SET used_at=datetime('now') WHERE account_id=? AND used_at IS NULL",
    args: [accountId],
  });
  await db.execute({
    sql: "INSERT INTO portal_setup_tokens (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    args: [randomUUID(), accountId, hashToken(token), expires],
  });
  return token;
}

async function createAccount(username: string, role: PortalRole): Promise<PortalAccount> {
  const id = randomUUID();
  try {
    await db.execute({
      sql: "INSERT INTO portal_accounts (id, username, username_key, role, active) VALUES (?, ?, ?, ?, 0)",
      args: [id, username, usernameKey(username), role],
    });
  } catch {
    throw new PortalError(409, "A website account already uses that username");
  }
  return { id, username, role, active: false };
}

function isTopAdmin(role: PortalRole): boolean {
  return role === "owner" || role === "head_manager";
}

function canManage(role: PortalRole): boolean {
  return role === "owner" || role === "head_manager" || role === "manager";
}

function roleFromDiscord(role: string | null): PortalRole {
  if (role === "owner" || role === "manager" || role === "trainer") return role;
  return "mechanic";
}

async function findCrewByName(displayName: string): Promise<Record<string, unknown>> {
  const result = await db.execute({
    sql: "SELECT discord_id, display_name, sales_channel_id FROM profiles WHERE display_name=? COLLATE NOCASE AND terminated_at IS NULL",
    args: [displayName.trim()],
  });
  if (result.rows.length === 0) throw new PortalError(404, "Active crew member not found");
  if (result.rows.length > 1) throw new PortalError(409, "More than one crew member has that name");
  const row = result.rows[0] as any;
  return {
    discord_id: String(row[0]),
    display_name: String(row[1]),
    sales_channel_id: row[2] ? String(row[2]) : null,
  };
}

async function findCrewForAccount(username: string): Promise<Record<string, unknown> | null> {
  const result = await db.execute(
    "SELECT discord_id, display_name, sales_channel_id FROM profiles WHERE terminated_at IS NULL ORDER BY display_name",
  );
  const key = usernameKey(username);
  const matches = result.rows.filter((row: any) => {
    const name = String(row[1] ?? "");
    const exact = usernameKey(name) === key;
    const firstName = usernameKey(name.split(/\s+/)[0] ?? "");
    return exact || firstName === key;
  });
  if (matches.length !== 1) return null;
  const row = matches[0] as any;
  return {
    discord_id: String(row[0]),
    display_name: String(row[1]),
    sales_channel_id: row[2] ? String(row[2]) : null,
  };
}

async function accountForCrewProfile(profile: Record<string, unknown>): Promise<AccountRow> {
  const existing = await lookupAccountForCrewProfile(profile);
  if (existing) return existing;
  const displayName = String(profile.display_name ?? "");
  const discordId = String(profile.discord_id ?? "");
  const role = roleFromDiscord(await getUserRole(discordId));
  const created = await createAccount(displayName, role);
  return {
    id: created.id,
    username: created.username,
    username_key: usernameKey(created.username),
    role: created.role,
    password_hash: null,
    password_salt: null,
    active: 0,
  };
}

async function lookupAccountForCrewProfile(profile: Record<string, unknown>): Promise<AccountRow | null> {
  const displayName = String(profile.display_name ?? "");
  const exact = await readAccountByUsername(displayName);
  if (exact) return exact;

  const firstName = displayName.split(/\s+/)[0];
  const shortName = await readAccountByUsername(firstName);
  if (!shortName) return null;

  const crew = await db.execute(
    "SELECT display_name FROM profiles WHERE terminated_at IS NULL ORDER BY display_name",
  );
  const sameFirstNameCount = crew.rows.filter((row: any) =>
    usernameKey(String(row[0] ?? "").split(/\s+/)[0] ?? "") === usernameKey(firstName),
  ).length;
  return sameFirstNameCount === 1 ? shortName : null;
}

async function sendSetupLink(
  client: Client,
  profile: Record<string, unknown>,
  account: AccountRow,
  origin: string,
): Promise<void> {
  const userId = String(profile.discord_id ?? "");
  const user = userId ? await client.users.fetch(userId).catch(() => null) : null;
  if (!user) throw new PortalError(409, "Discord could not find this crew member");
  const token = await issueSetupToken(account.id);
  const link = setupUrl(origin, token);
  try {
    await user.send({
      content: `Tokyo Drift Customs crew portal\nWebsite: ${origin}\nUsername: **${account.username}**\nSet your own private password using this one-time link (expires in ${SETUP_HOURS} hours):\n${link}`,
      allowedMentions: { parse: [] },
    });
  } catch {
    await db.execute({
      sql: "DELETE FROM portal_setup_tokens WHERE token_hash=?",
      args: [hashToken(token)],
    }).catch(() => {});
    throw new PortalError(409, "The bot could not DM this crew member. Ask them to allow direct messages, then retry");
  }
}

function isLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.since > 15 * 60 * 1000) {
    loginAttempts.set(key, { count: 1, since: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 8;
}

function resetLoginLimit(key: string): void {
  loginAttempts.delete(key);
}

function forwardedAddress(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

async function listCrew(client: Client): Promise<unknown[]> {
  const result = await db.execute(
    `SELECT p.discord_id, p.display_name, p.sales_channel_id, p.commission_rate,
            p.hours_worked_this_week, p.status, p.commission_adjustment, p.manager_cut_adjustment,
            p.manager_override_rate, p.in_city_id
     FROM profiles p WHERE p.terminated_at IS NULL ORDER BY p.display_name`,
  );
  const guildId = client.guilds.cache.first()?.id ?? "";
  const crew: unknown[] = [];
  for (const row of result.rows as any[]) {
    const discordId = String(row[0] ?? "");
    const displayName = String(row[1] ?? "");
    const botRole = await getUserRole(discordId);
    const account = await lookupAccountForCrewProfile({ display_name: displayName });
    const role = account ? parseRole(account.role) : roleFromDiscord(botRole);
    const pay = await getCommissionData(discordId, guildId, botRole ?? "mechanic").catch(() => null);
    const labor = await db.execute({
      sql: `SELECT COALESCE(SUM(labour),0), COUNT(*) FROM orders
            WHERE mechanic_id=? AND status IN ('complete','approved','paid')
              AND COALESCE(is_own_car,0)=0
              AND datetime(COALESCE(completed_at,created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key='order_number_reset_ts'),'2000-01-01'))`,
      args: [discordId],
    });
    const channelId = row[2] ? String(row[2]) : null;
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    crew.push({
      discord_id: discordId,
      display_name: displayName,
      role,
      status: String(row[5] ?? "offline"),
      in_city_id: row[9] ? String(row[9]) : null,
      sales_channel: channel?.type === ChannelType.GuildText ? channel.name : null,
      week_labour: Number(labor.rows[0]?.[0] ?? 0),
      week_orders: Number(labor.rows[0]?.[1] ?? 0),
      effective_rate: pay?.rate ?? Number(row[3] ?? 0.3),
      week_commission: pay?.weekCommission ?? 0,
      crew_cut: pay?.crewCut ?? 0,
      crew_cut_rate: pay?.crewCutRate ?? 0,
      total_pay: (pay?.weekCommission ?? 0) + (pay?.crewCut ?? 0),
    });
  }
  return crew;
}

async function listOrders(account: PortalAccount, status: string | null, limit: number): Promise<unknown[]> {
  const profile = isTopAdmin(account.role) ? null : await findCrewForAccount(account.username);
  if (!isTopAdmin(account.role) && !profile) throw new PortalError(403, "No crew record matches this account");
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (profile) {
    where.push("o.mechanic_id=?");
    args.push(String(profile.discord_id));
  }
  if (status && status !== "all") {
    if (!["draft", "complete", "approved", "paid", "rejected"].includes(status)) {
      throw new PortalError(400, "Invalid order status filter");
    }
    where.push("o.status=?");
    args.push(status);
  }
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT o.id,o.order_number,p.display_name,o.status,o.items,o.total,o.labour,o.parts_cost,
                 o.customer_name,o.notes,o.is_own_car,o.created_at,o.completed_at
          FROM orders o LEFT JOIN profiles p ON p.discord_id=o.mechanic_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY datetime(o.created_at) DESC LIMIT ?`,
    args,
  });
  return (result.rows as any[]).map((row) => {
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row[4] ?? "[]"));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
    return {
      id: String(row[0] ?? ""),
      order_number: String(row[1] ?? ""),
      mechanic_name: String(row[2] ?? "Unknown crew member"),
      status: String(row[3] ?? "draft"),
      items,
      total: Number(row[5] ?? 0),
      labour: Number(row[6] ?? 0),
      parts_cost: Number(row[7] ?? 0),
      customer_name: row[8] ? String(row[8]) : null,
      notes: String(row[9] ?? ""),
      is_own_car: Number(row[10] ?? 0) === 1,
      created_at: String(row[11] ?? ""),
      completed_at: row[12] ? String(row[12]) : null,
    };
  });
}

async function listPayouts(account: PortalAccount, limit: number): Promise<unknown[]> {
  const profile = isTopAdmin(account.role) ? null : await findCrewForAccount(account.username);
  if (!isTopAdmin(account.role) && !profile) throw new PortalError(403, "No crew record matches this account");
  const result = await db.execute({
    sql: `SELECT y.id,p.display_name,y.week_start,y.amount,y.manager_cut,y.hourly_pay,
                 y.order_count,y.hours_worked,y.paid_at,y.created_at
          FROM payouts y LEFT JOIN profiles p ON p.discord_id=y.mechanic_id
          ${profile ? "WHERE y.mechanic_id=?" : ""}
          ORDER BY datetime(COALESCE(y.paid_at,y.created_at)) DESC LIMIT ?`,
    args: profile ? [String(profile.discord_id), limit] : [limit],
  });
  return (result.rows as any[]).map((row) => ({
    id: String(row[0] ?? ""),
    mechanic_name: String(row[1] ?? "Unknown crew member"),
    week_start: String(row[2] ?? ""),
    amount: Number(row[3] ?? 0),
    manager_cut: Number(row[4] ?? 0),
    hourly_pay: Number(row[5] ?? 0),
    order_count: Number(row[6] ?? 0),
    hours_worked: Number(row[7] ?? 0),
    paid_at: row[8] ? String(row[8]) : null,
    created_at: String(row[9] ?? ""),
  }));
}

async function listChannels(
  client: Client,
  account: PortalAccount,
  requestedName: string | null,
): Promise<unknown[]> {
  const canSeeAll = isTopAdmin(account.role);
  const currentProfile = canSeeAll ? null : await findCrewForAccount(account.username);
  if (!canSeeAll && !currentProfile) throw new PortalError(403, "No crew record matches this account");
  const rows = canSeeAll && requestedName
    ? [await findCrewByName(requestedName)]
    : canSeeAll
      ? (await db.execute("SELECT discord_id,display_name,sales_channel_id FROM profiles WHERE terminated_at IS NULL ORDER BY display_name")).rows.map((row: any) => ({
          discord_id: String(row[0]),
          display_name: String(row[1]),
          sales_channel_id: row[2] ? String(row[2]) : null,
        }))
      : [currentProfile];
  const channels: unknown[] = [];
  for (const profile of rows) {
    if (!profile) continue;
    const profileRow = profile as Record<string, unknown>;
    const channelId = String(profileRow.sales_channel_id ?? "");
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    const messages = channel?.type === ChannelType.GuildText
      ? await (channel as TextChannel).messages.fetch({ limit: 30 }).catch(() => null)
      : null;
    channels.push({
      display_name: String(profileRow.display_name ?? ""),
      channel_name: channel?.type === ChannelType.GuildText ? channel.name : null,
      messages: messages
        ? [...messages.values()].map((message) => ({
            id: message.id,
            author: message.member?.displayName ?? message.author.username,
            is_bot: message.author.bot,
            content: message.content,
            created_at: message.createdAt.toISOString(),
            embeds: message.embeds.map((embed) => ({
              title: embed.title ?? null,
              description: embed.description ?? null,
              fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
            })),
          }))
        : [],
    });
  }
  return channels;
}

async function listAccounts(): Promise<PortalAccount[]> {
  const result = await db.execute(
    "SELECT id,username,username_key,role,password_hash,password_salt,active FROM portal_accounts ORDER BY username_key",
  );
  return (result.rows as unknown as AccountRow[]).map(toAccount);
}

function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PortalError(400, "Dates must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PortalError(400, "Enter a valid calendar date");
  }
  return value;
}

async function listTimeclock(account: PortalAccount, limit: number): Promise<unknown[]> {
  const maySeeAll = canManage(account.role) || account.role === "trainer";
  const profile = maySeeAll ? null : await findCrewForAccount(account.username);
  if (!maySeeAll && !profile) throw new PortalError(403, "No crew record matches this account");
  const result = await db.execute({
    sql: `SELECT t.id,t.mechanic_id,COALESCE(p.display_name,t.mechanic_id),t.clock_in_time,
                 t.clock_out_time,t.duration_minutes,t.status,t.notes,t.approved_by,t.created_at
          FROM timeclock t LEFT JOIN profiles p ON p.discord_id=t.mechanic_id
          ${profile ? "WHERE t.mechanic_id=?" : ""}
          ORDER BY datetime(t.created_at) DESC LIMIT ?`,
    args: profile ? [String(profile.discord_id), limit] : [limit],
  });
  const entries: unknown[] = [];
  for (const row of result.rows as any[]) {
    const id = String(row[0] ?? "");
    const mechanicId = String(row[1] ?? "");
    const clockIn = String(row[3] ?? "");
    const clockOut = row[4] ? String(row[4]) : null;
    const active = clockOut === null;
    const duration = active
      ? await calculateCreditedShiftMinutes(id, mechanicId, clockIn)
      : Number(row[5] ?? 0);
    entries.push({
      id,
      mechanic_id: mechanicId,
      mechanic_name: String(row[2] ?? mechanicId),
      clock_in_time: clockIn,
      clock_out_time: clockOut,
      duration_minutes: duration,
      status: String(row[6] ?? "approved"),
      notes: row[7] ? String(row[7]) : null,
      active,
      approved_by: row[8] ? String(row[8]) : null,
      created_at: String(row[9] ?? ""),
    });
  }
  return entries;
}

async function closeTimeclockEntry(
  client: Client,
  guild: Guild,
  id: string,
  actorId: string,
  actorName: string,
  reason: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT t.mechanic_id,t.clock_in_time,t.clock_message_id,t.clock_channel_id,p.display_name
          FROM timeclock t LEFT JOIN profiles p ON p.discord_id=t.mechanic_id
          WHERE t.id=? AND t.clock_out_time IS NULL`,
    args: [id],
  });
  const row = result.rows[0] as any;
  if (!row) return false;
  const mechanicId = String(row[0] ?? "");
  const clockIn = String(row[1] ?? "");
  const name = String(row[4] ?? mechanicId);
  const minutes = await calculateCreditedShiftMinutes(id, mechanicId, clockIn);
  const clockOut = new Date().toISOString().replace("T", " ").slice(0, 19);
  const updated = await db.execute({
    sql: `UPDATE timeclock
          SET clock_out_time=?,duration_minutes=?,status='approved',approved_by=?,warned_at=NULL,stayed_in_at=NULL,notes=?
          WHERE id=? AND clock_out_time IS NULL`,
    args: [clockOut, minutes, actorId, reason, id],
  });
  if (!updated.rowsAffected) return false;
  await db.execute({
    sql: "UPDATE profiles SET hours_worked_this_week=hours_worked_this_week+?,status='offline' WHERE discord_id=?",
    args: [minutes / 60, mechanicId],
  });
  warnedMechanics.delete(id);
  stayedIn.delete(mechanicId);

  const embed = buildClockOutEmbed(name, clockIn, clockOut, minutes, 0);
  const messageId = row[2] ? String(row[2]) : "";
  const messageChannelId = row[3] ? String(row[3]) : "";
  if (messageId && messageChannelId) {
    const sourceChannel = await client.channels.fetch(messageChannelId).catch(() => null);
    if (sourceChannel?.isTextBased()) {
      const message = await (sourceChannel as TextChannel).messages.fetch(messageId).catch(() => null);
      if (message) await message.edit({ embeds: [embed] }).catch(() => null);
    }
  }
  const config = await getGuildConfig(guild.id);
  if (config?.timeclock_channel_id) {
    const channel = await guild.channels.fetch(config.timeclock_channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        content: `${name} was clocked out by ${actorName}. ${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m credited. Reason: ${reason}`,
        embeds: [embed],
        allowedMentions: { parse: [] },
      }).catch(() => null);
    }
  }
  logEvent({
    kind: "clock_out",
    guildId: guild.id,
    userId: actorId,
    userName: actorName,
    detail: `Website clock-out for ${name}; ${Math.round(minutes)} minutes; ${reason}`,
  });
  await saveDatabaseSnapshot();
  return true;
}

async function listLeaveRequests(account: PortalAccount, status: string | null): Promise<unknown[]> {
  if (status && !["all", "pending", "approved", "denied"].includes(status)) {
    throw new PortalError(400, "Invalid leave request status");
  }
  const profile = canManage(account.role) ? null : await findCrewForAccount(account.username);
  if (!canManage(account.role) && !profile) throw new PortalError(403, "No crew record matches this account");
  const clauses: string[] = [];
  const args: string[] = [];
  if (profile) {
    clauses.push("l.mechanic_id=?");
    args.push(String(profile.discord_id));
  }
  if (status && status !== "all") {
    clauses.push("l.status=?");
    args.push(status);
  }
  const result = await db.execute({
    sql: `SELECT l.id,l.mechanic_id,COALESCE(p.display_name,l.mechanic_id),l.reason,
                 l.start_date,l.return_date,l.notes,l.status,l.reviewed_by,l.created_at
          FROM loa_requests l LEFT JOIN profiles p ON p.discord_id=l.mechanic_id
          ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY CASE WHEN l.status='pending' THEN 0 ELSE 1 END,datetime(l.created_at) DESC`,
    args,
  });
  return (result.rows as any[]).map((row) => ({
    id: String(row[0] ?? ""),
    mechanic_id: String(row[1] ?? ""),
    mechanic_name: String(row[2] ?? ""),
    reason: String(row[3] ?? ""),
    start_date: String(row[4] ?? ""),
    return_date: String(row[5] ?? ""),
    notes: row[6] ? String(row[6]) : null,
    status: String(row[7] ?? "pending"),
    reviewed_by: row[8] ? String(row[8]) : null,
    created_at: String(row[9] ?? ""),
  }));
}

async function getBankDashboard(client: Client): Promise<unknown> {
  const guild = await crewGuild(client);
  if (!guild) throw new PortalError(503, "Discord server unavailable");
  const [logs, unpaid] = await Promise.all([
    db.execute({
      sql: `SELECT b.id,b.log_date,b.balance,b.expected_balance,b.variance,b.expected_change,
                   b.payout_total,b.order_count,b.logged_by,p.display_name,b.logged_at
            FROM bank_account_logs b LEFT JOIN profiles p ON p.discord_id=b.logged_by
            WHERE b.guild_id=? ORDER BY datetime(b.logged_at) DESC LIMIT 100`,
      args: [guild.id],
    }),
    db.execute({
      sql: `SELECT p.discord_id,p.display_name,
                   COALESCE(SUM(y.amount+COALESCE(y.manager_cut,0)),0),COUNT(y.id),
                   COALESCE(p.current_pay_status,'pending')
            FROM profiles p JOIN payouts y ON y.mechanic_id=p.discord_id AND y.paid_at IS NULL
            GROUP BY p.discord_id,p.display_name,p.current_pay_status
            ORDER BY p.display_name`,
      args: [],
    }),
  ]);
  return {
    logs: (logs.rows as any[]).map((row) => ({
      id: String(row[0] ?? ""),
      log_date: String(row[1] ?? ""),
      balance: Number(row[2] ?? 0),
      expected_balance: Number(row[3] ?? 0),
      variance: Number(row[4] ?? 0),
      expected_change: Number(row[5] ?? 0),
      payout_total: Number(row[6] ?? 0),
      order_count: Number(row[7] ?? 0),
      logged_by: String(row[8] ?? ""),
      logged_by_name: row[9] ? String(row[9]) : null,
      logged_at: String(row[10] ?? ""),
    })),
    unpaid: (unpaid.rows as any[]).map((row) => ({
      discord_id: String(row[0] ?? ""),
      display_name: String(row[1] ?? ""),
      amount: Number(row[2] ?? 0),
      payout_count: Number(row[3] ?? 0),
      current_pay_status: String(row[4] ?? "pending"),
    })),
  };
}

async function syncMappedPortalRole(
  oldName: string,
  discordId: string,
  newName: string,
  role: string,
): Promise<void> {
  const account = await lookupAccountForCrewProfile({ display_name: oldName, discord_id: discordId });
  if (!account || account.role === "owner" || account.role === "head_manager") return;
  const oldNameKey = usernameKey(oldName);
  const oldFirstNameKey = usernameKey(oldName.split(/\s+/)[0] ?? "");
  const shouldRename = account.username_key === oldNameKey || account.username_key === oldFirstNameKey;
  if (shouldRename) {
    const collision = await db.execute({
      sql: "SELECT 1 FROM portal_accounts WHERE username_key=? AND id<>? LIMIT 1",
      args: [usernameKey(newName), account.id],
    });
    if (collision.rows[0]) {
      throw new PortalError(409, "The matching crew login could not be renamed because that username is already in use");
    }
    await db.execute({
      sql: "UPDATE portal_accounts SET role=?,username=?,username_key=? WHERE id=?",
      args: [role, newName, usernameKey(newName), account.id],
    });
  } else {
    await db.execute({ sql: "UPDATE portal_accounts SET role=? WHERE id=?", args: [role, account.id] });
  }
}

async function addCrewMember(client: Client, account: PortalAccount, body: Record<string, unknown>) {
  const discordId = typeof body.discord_id === "string" ? body.discord_id.trim() : "";
  if (!/^\d{17,20}$/.test(discordId)) throw new PortalError(400, "Enter a valid Discord user ID");
  const displayName = normalizeUsername(body.display_name);
  const role = String(body.role ?? "");
  if (!["mechanic", "trainer", "manager"].includes(role)) {
    throw new PortalError(400, "Crew role must be mechanic, trainer, or manager");
  }
  if (role === "manager" && !isTopAdmin(account.role)) {
    throw new PortalError(403, "Only an owner or head manager can assign the manager rank");
  }
  const currentRole = await getUserRole(discordId);
  if (currentRole === "owner") throw new PortalError(403, "The owner crew rank cannot be changed through roster entry");
  if (currentRole === "manager" && !isTopAdmin(account.role)) {
    throw new PortalError(403, "Only an owner or head manager can change a manager's rank");
  }
  const existingName = await db.execute({
    sql: "SELECT display_name FROM profiles WHERE discord_id=?",
    args: [discordId],
  });
  const oldName = existingName.rows[0] ? String(existingName.rows[0][0] ?? displayName) : displayName;
  const duplicate = await db.execute({
    sql: "SELECT 1 FROM profiles WHERE display_name=? COLLATE NOCASE AND discord_id<>? AND terminated_at IS NULL LIMIT 1",
    args: [displayName, discordId],
  });
  if (duplicate.rows[0]) throw new PortalError(409, "Another active crew member already has that display name");
  const guild = await crewGuild(client);
  if (!guild) throw new PortalError(503, "Discord server unavailable");
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member || member.user.bot) throw new PortalError(404, "That Discord user is not an active member of the TDC server");
  await db.execute({
    sql: "INSERT OR IGNORE INTO profiles (discord_id,display_name,commission_rate) VALUES (?,?,0.3)",
    args: [discordId, displayName],
  });
  await db.execute({
    sql: "UPDATE profiles SET display_name=?,status=CASE WHEN terminated_at IS NOT NULL THEN 'offline' ELSE status END,terminated_at=NULL WHERE discord_id=?",
    args: [displayName, discordId],
  });
  await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id=?", args: [discordId] });
  await db.execute({ sql: "INSERT INTO user_roles (discord_id,role) VALUES (?,?)", args: [discordId, role] });
  await syncMappedPortalRole(oldName, discordId, displayName, role);
  logEvent({
    kind: "crew_changed",
    guildId: guild.id,
    userId: discordId,
    userName: displayName,
    detail: `Added or updated as ${role} through the staff portal by ${account.username}`,
  });
  await saveDatabaseSnapshot();
  return { ok: true };
}

async function updateCrewMember(
  client: Client,
  account: PortalAccount,
  discordId: string,
  body: Record<string, unknown>,
) {
  if (!/^\d{17,20}$/.test(discordId)) throw new PortalError(400, "Invalid crew record");
  const result = await db.execute({
    sql: "SELECT display_name,terminated_at FROM profiles WHERE discord_id=?",
    args: [discordId],
  });
  if (!result.rows[0] || result.rows[0][1]) throw new PortalError(404, "Active crew member not found");
  const oldName = String(result.rows[0][0] ?? "");
  const oldRole = await getUserRole(discordId);
  if ((oldRole === "owner" && account.role !== "owner") ||
      (oldRole === "manager" && !isTopAdmin(account.role))) {
    throw new PortalError(403, "Only an owner or head manager can change this crew record");
  }
  const updates: string[] = [];
  const args: (string | null)[] = [];
  let newName = oldName;
  if (body.display_name !== undefined) {
    newName = normalizeUsername(body.display_name);
    const duplicate = await db.execute({
      sql: "SELECT 1 FROM profiles WHERE display_name=? COLLATE NOCASE AND discord_id<>? AND terminated_at IS NULL LIMIT 1",
      args: [newName, discordId],
    });
    if (duplicate.rows[0]) throw new PortalError(409, "Another active crew member already has that display name");
    updates.push("display_name=?");
    args.push(newName);
  }
  if (body.status !== undefined) {
    if (!["online", "offline", "on_break"].includes(String(body.status))) {
      throw new PortalError(400, "Invalid crew status");
    }
    updates.push("status=?");
    args.push(String(body.status));
  }
  if (body.in_city_id !== undefined) {
    if (body.in_city_id !== null && typeof body.in_city_id !== "string") {
      throw new PortalError(400, "In-city ID must be text or blank");
    }
    const cityId = typeof body.in_city_id === "string" ? body.in_city_id.trim() : "";
    if (cityId.length > 40) throw new PortalError(400, "In-city ID must be 40 characters or fewer");
    updates.push("in_city_id=?");
    args.push(cityId || null);
  }
  let newRole = oldRole ?? "mechanic";
  if (body.role !== undefined) {
    newRole = String(body.role);
    if (!["mechanic", "trainer", "manager", "owner"].includes(newRole)) {
      throw new PortalError(400, "Invalid crew rank");
    }
    if (newRole === "owner" && account.role !== "owner") {
      throw new PortalError(403, "Only an owner can assign the owner rank");
    }
    if ((newRole === "manager" || oldRole === "manager") && !isTopAdmin(account.role)) {
      throw new PortalError(403, "Only an owner or head manager can change manager ranks");
    }
    updates.push("__role__");
  }
  if (!updates.length) throw new PortalError(400, "No crew changes were provided");
  if (body.role !== undefined && newRole !== oldRole) {
    const guild = await crewGuild(client);
    const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
    if (member && guild) {
      const config = await getGuildConfig(guild.id);
      const roleMap: Record<string, string[]> = {
        owner: splitRoleIds(config?.owner_role_id),
        head_manager: splitRoleIds(config?.head_manager_role_id),
        manager: splitRoleIds(config?.manager_role_id),
        trainer: splitRoleIds(config?.trainer_role_id),
        mechanic: splitRoleIds(config?.mechanic_role_id),
      };
      const mappedIds = [...new Set([
        ...Object.values(roleMap).flat(),
        ...splitRoleIds((config as any)?.needs_training_role_id),
      ])];
      const toRemove = mappedIds.filter((roleId) => member.roles.cache.has(roleId));
      const toAdd = roleMap[newRole] ?? [];
      try {
        if (toRemove.length) await member.roles.remove(toRemove, `Crew rank updated through the staff portal by ${account.username}`);
        if (toAdd.length) await member.roles.add(toAdd, `Crew rank updated through the staff portal by ${account.username}`);
      } catch {
        throw new PortalError(502, "Discord role sync failed; the crew record was not changed");
      }
    }
  }
  if (newName !== oldName || body.role !== undefined) {
    await syncMappedPortalRole(oldName, discordId, newName, newRole);
  }
  const roleChanged = updates.includes("__role__");
  const profileUpdates = updates.filter((item) => item !== "__role__");
  if (profileUpdates.length) {
    args.push(discordId);
    await db.execute({
      sql: `UPDATE profiles SET ${profileUpdates.join(",")} WHERE discord_id=?`,
      args,
    });
  }
  if (roleChanged) {
    await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id=?", args: [discordId] });
    await db.execute({ sql: "INSERT INTO user_roles (discord_id,role) VALUES (?,?)", args: [discordId, newRole] });
  }
  const guild = await crewGuild(client);
  logEvent({
    kind: "crew_changed",
    guildId: guild?.id,
    userId: discordId,
    userName: newName,
    detail: `Updated through the staff portal by ${account.username}${roleChanged ? `; rank ${oldRole ?? "mechanic"} → ${newRole}` : ""}`,
  });
  await saveDatabaseSnapshot();
  return { ok: true };
}

export async function removeCrewMember(client: Client, account: PortalAccount, discordId: string) {
  if (!/^\d{17,20}$/.test(discordId)) throw new PortalError(400, "Invalid crew record");
  const result = await db.execute({
    sql: "SELECT display_name,terminated_at FROM profiles WHERE discord_id=?",
    args: [discordId],
  });
  if (!result.rows[0] || result.rows[0][1]) throw new PortalError(404, "Active crew member not found");
  const displayName = String(result.rows[0][0] ?? "");
  const ownProfile = await findCrewForAccount(account.username);
  if (ownProfile?.discord_id === discordId) throw new PortalError(403, "You cannot remove your own crew record");
  const role = await getUserRole(discordId);
  if (role === "owner") throw new PortalError(403, "The owner crew record cannot be removed");
  if (role === "manager" && !isTopAdmin(account.role)) {
    throw new PortalError(403, "Only an owner or head manager can remove a manager");
  }
  const guild = await crewGuild(client);
  if (!guild) throw new PortalError(503, "Discord server unavailable");
  const config = await getGuildConfig(guild.id);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (member) {
    const roleIds = [...new Set([
      ...splitRoleIds(config?.mechanic_role_id),
      ...splitRoleIds(config?.trainer_role_id),
      ...splitRoleIds(config?.manager_role_id),
      ...splitRoleIds((config as any)?.needs_training_role_id),
    ])];
    if (roleIds.length) {
      try {
        await member.roles.remove(roleIds, `Crew removed through staff portal by ${account.username}`);
      } catch {
        throw new PortalError(502, "Discord role cleanup failed; no crew records were changed");
      }
    }
  }
  const linkedAccount = await lookupAccountForCrewProfile({ display_name: displayName, discord_id: discordId });
  await db.execute({
    sql: "UPDATE profiles SET terminated_at=datetime('now'),status='offline' WHERE discord_id=? AND terminated_at IS NULL",
    args: [discordId],
  });
  await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id=?", args: [discordId] });
  if (linkedAccount && linkedAccount.role !== "owner" && linkedAccount.role !== "head_manager") {
    await db.execute({ sql: "UPDATE portal_accounts SET active=0 WHERE id=?", args: [linkedAccount.id] });
    await db.execute({ sql: "DELETE FROM portal_sessions WHERE account_id=?", args: [linkedAccount.id] });
    await db.execute({
      sql: "UPDATE portal_setup_tokens SET used_at=COALESCE(used_at,datetime('now')) WHERE account_id=?",
      args: [linkedAccount.id],
    });
  }
  logEvent({
    kind: "crew_changed",
    guildId: guild?.id,
    userId: discordId,
    userName: displayName,
    detail: `Deactivated through the staff portal by ${account.username}; historical orders and payouts preserved`,
  });
  await saveDatabaseSnapshot();
  return { ok: true };
}

export async function handlePortalApi(
  req: IncomingMessage,
  res: ServerResponse,
  client: Client,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/portal/session") {
      json(res, 200, await sessionResponse(req));
      return;
    }

    if (req.method === "POST" && path === "/api/portal/login") {
      const body = await bodyJson(req);
      const username = normalizeUsername(body.username);
      const password = typeof body.password === "string" ? body.password : "";
      const key = `${usernameKey(username)}:${forwardedAddress(req)}`;
      if (isLimited(key)) throw new PortalError(429, "Too many sign-in attempts. Try again in 15 minutes.");
      const row = await readAccountByUsername(username);
      let valid = false;
      if (row?.active && row.password_hash && row.password_salt) {
        const actual = await derivePassword(password, row.password_salt);
        const expected = Buffer.from(row.password_hash, "hex");
        valid = expected.length === actual.length && timingSafeEqual(expected, actual);
      }
      if (!valid || !row) throw new PortalError(401, "Username or password is incorrect");
      resetLoginLimit(key);
      const account = toAccount(row);
      await db.execute({ sql: "UPDATE portal_accounts SET last_login_at=datetime('now') WHERE id=?", args: [account.id] });
      await startSession(req, res, account);
      json(res, 200, { initialized: true, account });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/logout") {
      const token = parseCookie(req.headers.cookie, COOKIE_NAME);
      if (token) await db.execute({ sql: "DELETE FROM portal_sessions WHERE token_hash=?", args: [hashToken(token)] });
      clearSessionCookie(req, res);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/setup") {
      const body = await bodyJson(req);
      const expectedKey = process.env.PORTAL_SETUP_KEY ?? "";
      const suppliedKey = typeof body.setupKey === "string" ? body.setupKey : "";
      if (!expectedKey || expectedKey.length !== suppliedKey.length ||
          !timingSafeEqual(Buffer.from(expectedKey), Buffer.from(suppliedKey))) {
        throw new PortalError(401, "The setup key is invalid");
      }
      const claim = await db.execute({
        sql: "INSERT OR IGNORE INTO app_settings (key,value) VALUES ('portal_bootstrap_claim','1')",
        args: [],
      });
      if (!claim.rowsAffected) throw new PortalError(409, "Portal setup is already complete");
      const count = await db.execute("SELECT COUNT(*) FROM portal_accounts");
      if (Number(count.rows[0]?.[0] ?? 0) !== 0) {
        await db.execute("DELETE FROM app_settings WHERE key='portal_bootstrap_claim'");
        throw new PortalError(409, "Portal setup is already complete");
      }
      const username = normalizeUsername(body.username);
      const password = typeof body.password === "string" ? body.password : "";
      let accountId: string;
      try {
        const credentials = await passwordHash(password);
        accountId = randomUUID();
        await db.execute({
          sql: "INSERT INTO portal_accounts (id,username,username_key,role,password_hash,password_salt,active) VALUES (?,?,?,?,?,?,1)",
          args: [accountId, username, usernameKey(username), "owner", credentials.hash, credentials.salt],
        });
      } catch (error) {
        await db.execute("DELETE FROM app_settings WHERE key='portal_bootstrap_claim'");
        throw error;
      }
      await saveDatabaseSnapshot();
      const account: PortalAccount = { id: accountId, username, role: "owner", active: true };
      await startSession(req, res, account);
      json(res, 201, { initialized: true, account });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/activate") {
      const body = await bodyJson(req);
      const token = typeof body.token === "string" ? body.token : "";
      if (token.length < 20) throw new PortalError(400, "Invalid or expired setup link");
      const password = typeof body.password === "string" ? body.password : "";
      const credentials = await passwordHash(password);
      const found = await db.execute({
        sql: "SELECT account_id FROM portal_setup_tokens WHERE token_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime('now')",
        args: [hashToken(token)],
      });
      if (!found.rows[0]) throw new PortalError(400, "Invalid or expired setup link");
      const accountId = String(found.rows[0][0]);
      const claim = await db.execute({
        sql: "UPDATE portal_setup_tokens SET used_at=datetime('now') WHERE token_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime('now')",
        args: [hashToken(token)],
      });
      if (!claim.rowsAffected) throw new PortalError(400, "This setup link has already been used");
      await db.execute({
        sql: "UPDATE portal_accounts SET password_hash=?,password_salt=?,active=1 WHERE id=?",
        args: [credentials.hash, credentials.salt, accountId],
      });
      await saveDatabaseSnapshot();
      const result = await db.execute({
        sql: "SELECT id,username,username_key,role,password_hash,password_salt,active FROM portal_accounts WHERE id=? AND active=1",
        args: [accountId],
      });
      const accountRow = result.rows[0] as unknown as AccountRow | undefined;
      if (!accountRow) throw new PortalError(400, "Account is no longer available");
      const account = toAccount(accountRow);
      await startSession(req, res, account);
      json(res, 200, { initialized: true, account });
      return;
    }

    const account = await currentAccount(req);
    if (!account) throw new PortalError(401, "Sign in required");

    if (req.method === "GET" && path === "/api/portal/orders") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      json(res, 200, { orders: await listOrders(account, url.searchParams.get("status"), limit) });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/catalog") {
      const profile = await findCrewForAccount(account.username);
      if (!profile) throw new PortalError(403, "No active crew profile is linked to this account");
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      const [catalogText, currentRole, shift] = await Promise.all([
        getSetting("parts_catalog"),
        getUserRole(String(profile.discord_id)),
        db.execute({
          sql: "SELECT 1 FROM timeclock WHERE mechanic_id=? AND clock_out_time IS NULL LIMIT 1",
          args: [String(profile.discord_id)],
        }),
      ]);
      let catalog: any;
      try {
        catalog = JSON.parse(catalogText ?? "{}");
      } catch {
        throw new PortalError(503, "The shop catalog could not be read");
      }
      const sourceItems = Array.isArray(catalog.items) ? catalog.items : [];
      const categories = Array.isArray(catalog.categories)
        ? catalog.categories.map((category: unknown) => String(category))
        : [...new Set(sourceItems.map((item: any) => String(item.category ?? "")).filter(Boolean))];
      const items = sourceItems
        .map((item: any, index: number) => ({
          id: String(index),
          label: String(item.label ?? ""),
          category: String(item.category ?? ""),
          price: Number(item.price ?? 0),
          cost: Number(item.cost ?? 0),
          labour: Number(item.labour ?? 0),
        }))
        .filter((item: any) =>
          item.label && item.category &&
          [item.price, item.cost, item.labour].every(Number.isFinite) &&
          item.price >= 0 && item.cost >= 0 && item.labour >= 0
        );
      const commission = await getCommissionData(
        String(profile.discord_id),
        guild.id,
        currentRole ?? roleFromDiscord(account.role),
      );
      json(res, 200, {
        categories,
        items,
        commission_rate: commission.rate,
        week_commission: commission.weekCommission,
        active_shift: Boolean(shift.rows[0]),
      });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/orders") {
      const body = await bodyJson(req);
      const customerName = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
      const notes = typeof body.notes === "string" ? body.notes.trim() : "";
      const itemIds = body.item_ids;
      const requestedLabour = body.labour === undefined ? undefined : Number(body.labour);
      if (!customerName || customerName.length > 100) {
        throw new PortalError(400, "Enter a customer name (100 characters or fewer)");
      }
      if (notes.length > 500) throw new PortalError(400, "Notes must be 500 characters or fewer");
      if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 50 ||
          itemIds.some((id: unknown) => typeof id !== "string")) {
        throw new PortalError(400, "Select between 1 and 50 catalog service lines");
      }
      if (requestedLabour !== undefined &&
          (!Number.isFinite(requestedLabour) || requestedLabour < 0 || requestedLabour > 1_000_000_000)) {
        throw new PortalError(400, "Enter a valid labour amount");
      }
      const profile = await findCrewForAccount(account.username);
      if (!profile) throw new PortalError(403, "No active crew profile is linked to this account");
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      return await withOrderLock(`portal-new-order:${guild.id}:${profile.discord_id}`, async () => {
        const shift = await db.execute({
          sql: "SELECT 1 FROM timeclock WHERE mechanic_id=? AND clock_out_time IS NULL LIMIT 1",
          args: [String(profile.discord_id)],
        });
        if (!shift.rows[0]) throw new PortalError(409, "Clock in before starting an order, just like in Discord");
        const existing = await db.execute({
          sql: `SELECT order_number FROM orders
                WHERE mechanic_id=? AND status='draft' AND (guild_id=? OR guild_id='')
                ORDER BY datetime(created_at) DESC LIMIT 1`,
          args: [String(profile.discord_id), guild.id],
        });
        if (existing.rows[0]) {
          throw new PortalError(409, `Finish or cancel your open draft ${String(existing.rows[0][0])} before starting another order`);
        }

        let catalog: any;
        try {
          catalog = JSON.parse((await getSetting("parts_catalog")) ?? "{}");
        } catch {
          throw new PortalError(503, "The shop catalog could not be read");
        }
        const catalogItems = Array.isArray(catalog.items) ? catalog.items : [];
        const selected = itemIds.map((id: string) => {
          if (!/^\d+$/.test(id)) return null;
          const item = catalogItems[Number(id)];
          if (!item || !item.label || !item.category) return null;
          return {
            label: String(item.label),
            category: String(item.category),
            price: Number(item.price ?? 0),
            cost: Number(item.cost ?? 0),
            labour: Number(item.labour ?? 0),
          };
        });
        if (selected.some((item: any) =>
          !item || [item.price, item.cost, item.labour].some((value: number) => !Number.isFinite(value) || value < 0)
        )) {
          throw new PortalError(400, "One or more selected services are no longer in the shop catalog");
        }
        const partsCost = selected.reduce((sum: number, item: any) => sum + item.cost, 0);
        const labour = requestedLabour ?? selected.reduce((sum: number, item: any) => sum + item.labour, 0);
        const total = partsCost + labour;
        const role = await getUserRole(String(profile.discord_id)) ?? roleFromDiscord(account.role);
        const id = randomUUID();
        let orderNumber = await nextOrderNumber();
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await db.execute({
              sql: `INSERT INTO orders
                    (id, order_number, mechanic_id, guild_id, status, items, parts_cost, total, labour, notes, role_level, customer_name, is_own_car)
                    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 0)`,
              args: [
                id, orderNumber, String(profile.discord_id), guild.id, JSON.stringify(selected),
                partsCost, total, labour, notes, role, customerName,
              ],
            });
            break;
          } catch (error: any) {
            if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" && attempt < 4) {
              orderNumber = await nextOrderNumber();
              continue;
            }
            throw error;
          }
        }
        logEvent({
          kind: "order_created",
          guildId: guild.id,
          userId: String(profile.discord_id),
          userName: String(profile.display_name),
          orderId: id,
          orderNumber,
          detail: "created through the crew website",
        });
        await saveDatabaseSnapshot();
        return json(res, 201, { id, order_number: orderNumber });
      });
    }

    if (req.method === "GET" && path === "/api/portal/crew") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      json(res, 200, { crew: await listCrew(client) });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/channels") {
      json(res, 200, { channels: await listChannels(client, account, url.searchParams.get("displayName")) });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/payouts") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      json(res, 200, { payouts: await listPayouts(account, limit) });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/accounts") {
      if (!isTopAdmin(account.role)) throw new PortalError(403, "Owner or head manager required");
      json(res, 200, { accounts: await listAccounts() });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/accounts") {
      if (!isTopAdmin(account.role)) throw new PortalError(403, "Owner or head manager required");
      const body = await bodyJson(req);
      const username = normalizeUsername(body.username);
      const role = parseRole(body.role);
      if (role === "owner" && account.role !== "owner") {
        throw new PortalError(403, "Only an owner can create another owner account");
      }
      const origin = setupOrigin(req);
      let portalAccount: PortalAccount;
      const existing = await readAccountByUsername(username);
      if (existing && !existing.active && !existing.password_hash) {
        await db.execute({ sql: "UPDATE portal_accounts SET role=? WHERE id=?", args: [role, existing.id] });
        portalAccount = { ...toAccount(existing), role };
      } else if (existing) {
        throw new PortalError(409, "An active account already uses that username");
      } else {
        portalAccount = await createAccount(username, role);
      }
      const token = await issueSetupToken(portalAccount.id);
      await saveDatabaseSnapshot();
      json(res, 201, { account: portalAccount, setup_url: setupUrl(origin, token) });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/invites/all") {
      if (!isTopAdmin(account.role)) throw new PortalError(403, "Owner or head manager required");
      const origin = setupOrigin(req);
      const result = await db.execute(
        "SELECT discord_id,display_name,sales_channel_id FROM profiles WHERE terminated_at IS NULL ORDER BY display_name",
      );
      let sent = 0;
      let skipped = 0;
      const failures: string[] = [];
      for (const row of result.rows as any[]) {
        const profile = {
          discord_id: String(row[0] ?? ""),
          display_name: String(row[1] ?? ""),
          sales_channel_id: row[2] ? String(row[2]) : null,
        };
        try {
          const crewAccount = await accountForCrewProfile(profile);
          if (Number(crewAccount.active) === 1) {
            skipped++;
            continue;
          }
          await sendSetupLink(client, profile, crewAccount, origin);
          sent++;
        } catch (error) {
          skipped++;
          failures.push(`${profile.display_name}: ${error instanceof Error ? error.message : "delivery failed"}`);
        }
      }
      await saveDatabaseSnapshot();
      json(res, 200, { sent, skipped, failures });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/invites/one") {
      if (!isTopAdmin(account.role)) throw new PortalError(403, "Owner or head manager required");
      const body = await bodyJson(req);
      const name = normalizeUsername(body.display_name);
      const profile = await findCrewByName(name);
      const origin = setupOrigin(req);
      const crewAccount = await accountForCrewProfile(profile);
      if (Number(crewAccount.active) === 1) {
        json(res, 200, { sent: 0, skipped: 1, failures: [`${name}: account is already active`] });
        return;
      }
      try {
        await sendSetupLink(client, profile, crewAccount, origin);
        await saveDatabaseSnapshot();
        json(res, 200, { sent: 1, skipped: 0, failures: [] });
      } catch (error) {
        json(res, 200, {
          sent: 0,
          skipped: 1,
          failures: [`${name}: ${error instanceof Error ? error.message : "delivery failed"}`],
        });
      }
      return;
    }

    if (req.method === "POST" && path === "/api/portal/pay") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      const name = normalizeUsername(body.display_name);
      const profile = await findCrewByName(name);
      const result = await websiteSetPay(client, {
        ...body,
        discord_id: profile.discord_id,
        actor_id: `portal:${account.id}`,
        actor_name: account.username,
      });
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && path === "/api/portal/payroll") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      const result = await websitePayroll(client, {
        request_id: body.request_id,
        portal_actor: {
          id: account.id,
          username: account.username,
          role: account.role,
        },
      });
      json(res, 200, result);
      return;
    }

    if (req.method === "GET" && path === "/api/portal/timeclock") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      json(res, 200, { entries: await listTimeclock(account, limit) });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/timeclock/reset") {
      if (account.role !== "owner") throw new PortalError(403, "Owner role required");
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      const active = await db.execute("SELECT id FROM timeclock WHERE clock_out_time IS NULL ORDER BY clock_in_time");
      let clockedOut = 0;
      for (const row of active.rows) {
        const id = String((row as any)[0] ?? "");
        if (await closeTimeclockEntry(client, guild, id, `portal:${account.id}`, account.username, "Emergency portal timeclock reset")) {
          clockedOut++;
        }
      }
      warnedMechanics.clear();
      stayedIn.clear();
      await db.execute("UPDATE timeclock SET warned_at=NULL,stayed_in_at=NULL WHERE warned_at IS NOT NULL OR stayed_in_at IS NOT NULL");
      logEvent({
        kind: "crew_changed",
        guildId: guild.id,
        userId: `portal:${account.id}`,
        userName: account.username,
        detail: `Emergency clock-out reset from staff portal; ${clockedOut} active session(s) closed`,
      });
      await saveDatabaseSnapshot();
      json(res, 200, { ok: true, clocked_out: clockedOut });
      return;
    }

    const clockReviewMatch = path.match(/^\/api\/portal\/timeclock\/([^/]+)\/review$/);
    if (req.method === "POST" && clockReviewMatch) {
      if (!(canManage(account.role) || account.role === "trainer")) {
        throw new PortalError(403, "Trainer or manager role required");
      }
      const body = await bodyJson(req);
      const decision = String(body.decision ?? "");
      if (decision !== "approved" && decision !== "rejected") {
        throw new PortalError(400, "Choose approve or reject");
      }
      const id = decodeURIComponent(clockReviewMatch[1]);
      const entry = await db.execute({
        sql: "SELECT mechanic_id,duration_minutes FROM timeclock WHERE id=? AND status='pending' AND clock_out_time IS NOT NULL",
        args: [id],
      });
      if (!entry.rows[0]) throw new PortalError(409, "This timeclock entry is no longer pending review");
      const mechanicId = String((entry.rows[0] as any)[0] ?? "");
      const durationMinutes = Number((entry.rows[0] as any)[1] ?? 0);
      const updated = await db.execute({
        sql: "UPDATE timeclock SET status=?,approved_by=? WHERE id=? AND status='pending' AND clock_out_time IS NOT NULL",
        args: [decision, `portal:${account.id}`, id],
      });
      if (!updated.rowsAffected) throw new PortalError(409, "This timeclock entry was already reviewed");
      if (decision === "approved") {
        await db.execute({
          sql: "UPDATE profiles SET hours_worked_this_week=hours_worked_this_week+? WHERE discord_id=?",
          args: [durationMinutes / 60, mechanicId],
        });
      }
      const guild = await crewGuild(client);
      logEvent({
        kind: "crew_changed",
        guildId: guild?.id,
        userId: `portal:${account.id}`,
        userName: account.username,
        detail: `Timeclock ${id} ${decision} for ${mechanicId}; ${Math.round(durationMinutes)} minutes`,
      });
      await saveDatabaseSnapshot();
      json(res, 200, { ok: true });
      return;
    }

    const forceClockOutMatch = path.match(/^\/api\/portal\/timeclock\/([^/]+)\/clock-out$/);
    if (req.method === "POST" && forceClockOutMatch) {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      const id = decodeURIComponent(forceClockOutMatch[1]);
      const closed = await closeTimeclockEntry(
        client,
        guild,
        id,
        `portal:${account.id}`,
        account.username,
        reason || "Clocked out by staff portal manager",
      );
      if (!closed) throw new PortalError(409, "This session is already clocked out");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/loa") {
      const status = url.searchParams.get("status");
      json(res, 200, { requests: await listLeaveRequests(account, status) });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/loa") {
      const body = await bodyJson(req);
      const profile = await findCrewForAccount(account.username);
      if (!profile) throw new PortalError(403, "No matching crew record; leave requests must be submitted from a crew account");
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason || reason.length > 500) throw new PortalError(400, "Reason must be 1–500 characters");
      const startDate = validDate(body.start_date);
      const returnDate = validDate(body.return_date);
      if (returnDate < startDate) throw new PortalError(400, "Return date must be on or after the start date");
      const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 300) : "";
      const id = randomUUID();
      await db.execute({
        sql: "INSERT INTO loa_requests (id,mechanic_id,guild_id,reason,start_date,return_date,notes) VALUES (?,?,?,?,?,?,?)",
        args: [id, String(profile.discord_id), guild.id, reason, startDate, returnDate, notes || null],
      });
      const request = {
        id,
        mechanic_id: String(profile.discord_id),
        mechanic_name: String(profile.display_name ?? account.username),
        reason,
        start_date: startDate,
        return_date: returnDate,
        notes: notes || null,
        status: "pending",
        reviewed_by: null,
        created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      };
      logEvent({
        kind: "loa_submitted",
        guildId: guild.id,
        userId: String(profile.discord_id),
        userName: request.mechanic_name,
        detail: `${startDate} → ${returnDate} · ${reason.slice(0, 120)}`,
      });
      const config = await getGuildConfig(guild.id);
      if (config?.loa_channel_id) {
        const channel = await guild.channels.fetch(config.loa_channel_id).catch(() => null);
        if (channel?.isTextBased()) {
          const embed = buildLoaEmbed({
            mechanic_name: request.mechanic_name,
            reason,
            start_date: startDate,
            return_date: returnDate,
            notes: notes || undefined,
            status: "pending",
          });
          const reviewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`loa:approve:${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`loa:deny:${id}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          );
          const message = await (channel as TextChannel).send({
            content: `New leave request from ${request.mechanic_name}`,
            embeds: [embed],
            components: [reviewRow],
            allowedMentions: { parse: [] },
          }).catch(() => null);
          if (message) {
            await db.execute({ sql: "UPDATE loa_requests SET discord_message_id=? WHERE id=?", args: [message.id, id] });
          }
        }
      }
      await saveDatabaseSnapshot();
      json(res, 201, { request });
      return;
    }

    const leaveReviewMatch = path.match(/^\/api\/portal\/loa\/([^/]+)\/review$/);
    if (req.method === "POST" && leaveReviewMatch) {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      const decision = String(body.decision ?? "");
      if (decision !== "approved" && decision !== "denied") {
        throw new PortalError(400, "Choose approve or deny");
      }
      const id = decodeURIComponent(leaveReviewMatch[1]);
      const updated = await db.execute({
        sql: "UPDATE loa_requests SET status=?,reviewed_by=? WHERE id=? AND status='pending'",
        args: [decision, `portal:${account.id}`, id],
      });
      if (!updated.rowsAffected) throw new PortalError(409, "This leave request is no longer pending review");
      const result = await db.execute({
        sql: `SELECT l.mechanic_id,l.guild_id,l.reason,l.start_date,l.return_date,l.notes,
                     l.discord_message_id,COALESCE(p.display_name,l.mechanic_id)
              FROM loa_requests l LEFT JOIN profiles p ON p.discord_id=l.mechanic_id
              WHERE l.id=?`,
        args: [id],
      });
      const row = result.rows[0] as any;
      if (!row) throw new PortalError(404, "Leave request not found");
      const mechanicId = String(row[0] ?? "");
      const guildId = String(row[1] ?? "");
      const mechanicName = String(row[7] ?? mechanicId);
      const reviewer = account.username;
      const embed = buildLoaEmbed({
        mechanic_name: mechanicName,
        reason: String(row[2] ?? ""),
        start_date: String(row[3] ?? ""),
        return_date: String(row[4] ?? ""),
        notes: row[5] ? String(row[5]) : undefined,
        status: decision,
      });
      embed.addFields({ name: "Reviewed By", value: reviewer, inline: true });
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      const messageId = row[6] ? String(row[6]) : "";
      const config = guild ? await getGuildConfig(guild.id) : null;
      const channel = guild && config?.loa_channel_id
        ? await guild.channels.fetch(config.loa_channel_id).catch(() => null)
        : null;
      if (channel?.isTextBased() && messageId) {
        const message = await (channel as TextChannel).messages.fetch(messageId).catch(() => null);
        if (message) await message.edit({ embeds: [embed], components: [] }).catch(() => null);
      }
      try {
        const user = await client.users.fetch(mechanicId);
        await user.send({
          content: `Your leave request (${String(row[3])} to ${String(row[4])}) was ${decision}.`,
          embeds: [embed],
        });
      } catch {
        // A crew member may have DMs disabled; the portal decision remains saved.
      }
      logEvent({
        kind: decision === "approved" ? "loa_approved" : "loa_denied",
        guildId,
        userId: mechanicId,
        userName: mechanicName,
        detail: `${String(row[3])} → ${String(row[4])} · reviewed by ${reviewer}`,
      });
      await saveDatabaseSnapshot();
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && path === "/api/portal/bank") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      json(res, 200, await getBankDashboard(client));
      return;
    }

    if (req.method === "POST" && path === "/api/portal/bank/record") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 0) {
        throw new PortalError(400, "Enter a valid non-negative bank balance");
      }
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      const comparison = await recordBankBalance(guild.id, body.amount, `portal:${account.id}`);
      const config = await getGuildConfig(guild.id);
      if (config?.bank_account_channel_id) {
        const channel = await guild.channels.fetch(config.bank_account_channel_id).catch(() => null);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send({
            embeds: [buildBankLogEmbed(comparison)],
            components: (await isUpdateEnabled()) ? buildBankPaidComponents() : [],
          }).catch(() => null);
        }
      }
      logEvent({
        kind: "database_event",
        guildId: guild.id,
        userId: `portal:${account.id}`,
        userName: account.username,
        amount: body.amount,
        detail: `Bank balance recorded for ${comparison.logDate}; variance ${comparison.variance}`,
      });
      await saveDatabaseSnapshot();
      json(res, 200, {
        log_date: comparison.logDate,
        balance: comparison.balance,
        previous_balance: comparison.previousBalance,
        order_revenue: comparison.orderRevenue,
        order_count: comparison.orderCount,
        payout_total: comparison.payoutTotal,
        payout_count: comparison.payoutCount,
        expected_balance: comparison.expectedBalance,
        actual_change: comparison.actualChange,
        variance: comparison.variance,
        shortfall: comparison.shortfall,
        surplus: comparison.surplus,
        logged_by: comparison.loggedBy,
        logged_at: comparison.loggedAt,
        is_update: comparison.isUpdate,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/bank/reset") {
      if (!isTopAdmin(account.role)) throw new PortalError(403, "Owner or head manager role required");
      const body = await bodyJson(req);
      if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 0) {
        throw new PortalError(400, "Enter a valid non-negative bank balance");
      }
      const guild = await crewGuild(client);
      if (!guild) throw new PortalError(503, "Discord server unavailable");
      await resetBankBaseline(guild.id, body.amount, `portal:${account.id}`);
      logEvent({
        kind: "database_event",
        guildId: guild.id,
        userId: `portal:${account.id}`,
        userName: account.username,
        amount: body.amount,
        detail: "Bank tracking baseline reset from staff portal; historical logs preserved",
      });
      await saveDatabaseSnapshot();
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/bank/mark-paid") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      if (!Array.isArray(body.discord_ids) || body.discord_ids.length < 1 || body.discord_ids.length > 100) {
        throw new PortalError(400, "Choose at least one crew member to mark paid");
      }
      const ids = [...new Set(body.discord_ids.map((value) => String(value)))];
      if (ids.some((id) => !/^\d{17,20}$/.test(id))) throw new PortalError(400, "One or more crew IDs are invalid");
      let markedCount = 0;
      let total = 0;
      for (const discordId of ids) {
        const unpaid = await db.execute({
          sql: "SELECT COALESCE(SUM(amount+COALESCE(manager_cut,0)),0) FROM payouts WHERE mechanic_id=? AND paid_at IS NULL",
          args: [discordId],
        });
        const amount = Number(unpaid.rows[0]?.[0] ?? 0);
        const paid = await db.execute({
          sql: "UPDATE payouts SET paid_at=datetime('now'),paid_by=? WHERE mechanic_id=? AND paid_at IS NULL",
          args: [`portal:${account.id}`, discordId],
        });
        if (!paid.rowsAffected) continue;
        await db.execute({
          sql: "UPDATE profiles SET current_pay_status='paid' WHERE discord_id=?",
          args: [discordId],
        });
        markedCount++;
        total += amount;
      }
      const guild = await crewGuild(client);
      if (guild) {
        const { refreshPayLogPanel } = await import("../commands/payall.js");
        refreshPayLogPanel(guild).catch(() => {});
        logEvent({
          kind: "payout_processed",
          guildId: guild.id,
          userId: `portal:${account.id}`,
          userName: account.username,
          amount: total,
          detail: `Marked ${markedCount} crew member(s) paid through the staff portal`,
        });
      }
      await saveDatabaseSnapshot();
      json(res, 200, { ok: true, marked_count: markedCount, total });
      return;
    }

    if (req.method === "POST" && path === "/api/portal/crew") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const body = await bodyJson(req);
      json(res, 200, await addCrewMember(client, account, body));
      return;
    }

    const crewMemberMatch = path.match(/^\/api\/portal\/crew\/([^/]+)$/);
    if (crewMemberMatch && req.method === "PATCH") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const discordId = decodeURIComponent(crewMemberMatch[1]);
      const body = await bodyJson(req);
      json(res, 200, await updateCrewMember(client, account, discordId, body));
      return;
    }
    if (crewMemberMatch && req.method === "DELETE") {
      if (!canManage(account.role)) throw new PortalError(403, "Manager role required");
      const discordId = decodeURIComponent(crewMemberMatch[1]);
      json(res, 200, await removeCrewMember(client, account, discordId));
      return;
    }

    const completionMatch = path.match(/^\/api\/portal\/orders\/([^/]+)\/complete$/);
    if (req.method === "POST" && completionMatch) {
      const orderId = decodeURIComponent(completionMatch[1]);
      const order = await db.execute({ sql: "SELECT mechanic_id FROM orders WHERE id=?", args: [orderId] });
      if (!order.rows[0]) throw new PortalError(404, "Order not found");
      const mechanicId = String(order.rows[0][0] ?? "");
      const ownProfile = await findCrewForAccount(account.username);
      const ownsOrder = ownProfile?.discord_id === mechanicId;
      if (!ownsOrder && !["owner", "head_manager", "manager"].includes(account.role)) {
        throw new PortalError(403, "This order belongs to another mechanic");
      }
      await websiteComplete(client, {
        order_id: orderId,
        portal_actor: {
          id: account.id,
          username: account.username,
          role: account.role,
          discord_id: ownProfile?.discord_id ?? null,
        },
      });
      json(res, 200, { ok: true });
      return;
    }

    throw new PortalError(404, "Portal endpoint not found");
  } catch (error) {
    if (error instanceof PortalError) {
      json(res, error.status, { error: error.message });
      return;
    }
    console.error("[TDC] Portal request failed:", error);
    json(res, 500, { error: "Portal request failed" });
  }
}
