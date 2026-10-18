import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ChannelType, type Client, type TextChannel } from "discord.js";
import {
  db,
  getProfile,
  getUserRole,
  saveDatabaseSnapshot,
} from "../db.js";
import { getCommissionData } from "../interactions/draftbuttons.js";
import {
  websiteComplete,
  websiteSetPay,
} from "./websiteActions.js";

type PortalRole = "owner" | "head_manager" | "manager" | "trainer" | "mechanic";
type PortalAccount = {
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
  const channelId = String(profile.sales_channel_id ?? "");
  if (!channelId) throw new PortalError(409, "No sales channel is configured");
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new PortalError(409, "The sales channel is unavailable to the bot");
  }
  const token = await issueSetupToken(account.id);
  const link = setupUrl(origin, token);
  await (channel as TextChannel).send({
    content: `Tokyo Drift Customs crew portal\nUsername: **${account.username}**\nSet your own private password using this one-time link (expires in ${SETUP_HOURS} hours):\n${link}`,
    allowedMentions: { parse: [] },
  });
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
            p.manager_override_rate
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
      display_name: displayName,
      role,
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
        if (!profile.sales_channel_id) {
          skipped++;
          failures.push(`${profile.display_name}: no sales channel configured`);
          continue;
        }
        try {
          const crewAccount = await accountForCrewProfile(profile);
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
      if (!profile.sales_channel_id) {
        json(res, 200, { sent: 0, skipped: 1, failures: [`${name}: no sales channel configured`] });
        return;
      }
      const origin = setupOrigin(req);
      const crewAccount = await accountForCrewProfile(profile);
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
