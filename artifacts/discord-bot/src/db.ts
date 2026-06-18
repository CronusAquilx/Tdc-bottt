import { createClient } from "@libsql/client";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = createClient({
  url: `file:${path.join(DATA_DIR, "tdc.db")}`
});

async function exec(sql: string) {
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await db.execute(stmt);
  }
}

async function safeAlter(sql: string) {
  try { await db.execute(sql); } catch { /* column already exists */ }
}

export async function initDb() {
  await exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      discord_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      sales_channel_id TEXT,
      commission_rate REAL NOT NULL DEFAULT 0.4,
      hours_worked_this_week REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'offline',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      discord_id TEXT NOT NULL,
      role TEXT NOT NULL,
      UNIQUE(discord_id, role)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      mechanic_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      items TEXT NOT NULL DEFAULT '[]',
      parts_cost REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      labour REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      rejected_reason TEXT,
      discord_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      approved_by TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS timeclock (
      id TEXT PRIMARY KEY,
      mechanic_id TEXT NOT NULL,
      clock_in_time TEXT NOT NULL,
      clock_out_time TEXT,
      duration_minutes REAL NOT NULL DEFAULT 0,
      approved_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      mechanic_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      order_count INTEGER NOT NULL DEFAULT 0,
      hours_worked REAL NOT NULL DEFAULT 0,
      invoice_count INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT,
      paid_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      posted_by TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      discord_message_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      orders_channel_id TEXT,
      jobs_channel_id TEXT,
      log_channel_id TEXT,
      archive_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Safe migrations — add new columns if they don't exist yet
  await safeAlter("ALTER TABLE guild_config ADD COLUMN owner_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN manager_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN trainer_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN mechanic_role_id TEXT");

  // Seed default settings
  const defaultCatalog = JSON.stringify({
    categories: ["Performance", "Visual & Body", "Tires", "Misc", "Upgrades", "Interior"],
    items: [
      { label: "Turbo Upgrade", category: "Performance", price: 15000, cost: 8000 },
      { label: "ECU Tune", category: "Performance", price: 8000, cost: 3000 },
      { label: "Cold Air Intake", category: "Performance", price: 3500, cost: 1500 },
      { label: "Exhaust System", category: "Performance", price: 9000, cost: 4500 },
      { label: "Suspension Kit", category: "Performance", price: 12000, cost: 6000 },
      { label: "Custom Paint", category: "Visual & Body", price: 20000, cost: 8000 },
      { label: "Body Kit", category: "Visual & Body", price: 18000, cost: 9000 },
      { label: "Spoiler", category: "Visual & Body", price: 5000, cost: 2000 },
      { label: "Window Tint", category: "Visual & Body", price: 3000, cost: 800 },
      { label: "Wheels", category: "Tires", price: 14000, cost: 7000 },
      { label: "Tire Set", category: "Tires", price: 8000, cost: 4000 },
      { label: "Lowering Springs", category: "Upgrades", price: 6000, cost: 2500 },
      { label: "Brake Upgrade", category: "Upgrades", price: 10000, cost: 5000 },
      { label: "Seat Swap", category: "Interior", price: 7000, cost: 3000 },
      { label: "Roll Cage", category: "Interior", price: 25000, cost: 12000 },
      { label: "Misc Parts", category: "Misc", price: 2000, cost: 1000 }
    ]
  });

  await db.execute({ sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)", args: ["commission_default", "0.4"] });
  await db.execute({ sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)", args: ["parts_catalog", defaultCatalog] });

  // Seed owners
  const owners = [
    { id: "198572092504014848", name: "Lu Chenzo" },
    { id: "378293480608497664", name: "Phoenix" },
    { id: "1363222342800511058", name: "Sierra Phoenix" }
  ];
  const mechanics = [
    { id: "1179942814906327050", name: "Myx" },
    { id: "1088337283180146758", name: "Yancy" },
    { id: "623677968786653194", name: "Uncle Cracker" },
    { id: "1445564490463711413", name: "Smoke" },
    { id: "1069621699378679828", name: "Magnus" },
    { id: "733808236293128314", name: "Louielue" },
    { id: "727706928536616963", name: "Dayytradezz" },
    { id: "1455587333071175755", name: "Ahmed Brown" },
    { id: "748420441881706534", name: "Onlythegamers" },
    { id: "1302529753739427961", name: "Dreico" },
    { id: "466238601672392734", name: "Ron" },
    { id: "1246285610319347754", name: "Mr Walkdown" },
    { id: "", name: "Motion Montona" },
    { id: "312410738977144832", name: "Brandon Strong" },
    { id: "1363222342800511058", name: "Ander Dingus" },
    { id: "463492813711999006", name: "Ab" }
  ];

  for (const o of owners) {
    await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name) VALUES (?, ?)", args: [o.id, o.name] });
    await db.execute({ sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, ?)", args: [o.id, "owner"] });
  }
  for (const m of mechanics) {
    if (!m.id) continue;
    await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name) VALUES (?, ?)", args: [m.id, m.name] });
    await db.execute({ sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, ?)", args: [m.id, "mechanic"] });
  }

  console.log("[TDC] Database initialized.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [key] });
  return r.rows[0] ? String(r.rows[0][0]) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.execute({ sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", args: [key, value] });
}

export async function getGuildConfig(guildId: string) {
  const r = await db.execute({ sql: "SELECT * FROM guild_config WHERE guild_id = ?", args: [guildId] });
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    guild_id: String(row[0] ?? ""),
    orders_channel_id: row[1] ? String(row[1]) : null,
    jobs_channel_id: row[2] ? String(row[2]) : null,
    log_channel_id: row[3] ? String(row[3]) : null,
    archive_channel_id: row[4] ? String(row[4]) : null,
    owner_role_id: row[5] ? String(row[5]) : null,
    manager_role_id: row[6] ? String(row[6]) : null,
    trainer_role_id: row[7] ? String(row[7]) : null,
    mechanic_role_id: row[8] ? String(row[8]) : null,
  };
}

export async function setGuildConfig(
  guildId: string,
  field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id",
  channelId: string
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}`,
    args: [guildId, channelId]
  });
}

export async function setGuildRoleMapping(
  guildId: string,
  level: "owner" | "manager" | "trainer" | "mechanic",
  roleId: string
): Promise<void> {
  const field = `${level}_role_id`;
  await db.execute({
    sql: `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}`,
    args: [guildId, roleId]
  });
}

export async function nextOrderNumber(): Promise<string> {
  const r = await db.execute("SELECT order_number FROM orders ORDER BY rowid DESC LIMIT 1");
  if (!r.rows[0]) return "TDC-0001";
  const num = parseInt(String(r.rows[0][0]).replace("TDC-", ""), 10) + 1;
  return `TDC-${String(num).padStart(4, "0")}`;
}

export async function getProfile(discordId: string) {
  const r = await db.execute({ sql: "SELECT * FROM profiles WHERE discord_id = ?", args: [discordId] });
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    discord_id: String(row[0] ?? ""),
    display_name: String(row[1] ?? ""),
    sales_channel_id: row[2] ? String(row[2]) : null,
    commission_rate: Number(row[3] ?? 0.4),
    hours_worked_this_week: Number(row[4] ?? 0),
    status: String(row[5] ?? "offline"),
    created_at: String(row[6] ?? ""),
  };
}

export async function ensureProfile(discordId: string, displayName: string) {
  await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name) VALUES (?, ?)", args: [discordId, displayName] });
  return getProfile(discordId);
}

export async function getUserRole(discordId: string): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT role FROM user_roles WHERE discord_id = ?", args: [discordId] });
  if (!r.rows.length) return null;
  const hierarchy: Record<string, number> = { owner: 4, manager: 3, trainer: 2, mechanic: 1 };
  const roles = r.rows.map(row => String(row[0]));
  return roles.reduce((best, role) => (hierarchy[role] ?? 0) > (hierarchy[best] ?? 0) ? role : best);
}

export async function hasRole(discordId: string, minRole: string): Promise<boolean> {
  const hierarchy: Record<string, number> = { owner: 4, manager: 3, trainer: 2, mechanic: 1 };
  const role = await getUserRole(discordId);
  if (!role) return false;
  return (hierarchy[role] ?? 0) >= (hierarchy[minRole] ?? 0);
}

// Row-to-object helpers
function cell(row: unknown, idx: number): unknown {
  if (Array.isArray(row)) return row[idx];
  if (row && typeof row === "object") return (row as Record<string | number, unknown>)[idx];
  return undefined;
}

export function rowToOrder(row: unknown): import("./types.js").Order {
  const c = (i: number) => cell(row, i);
  return {
    id: String(c(0) ?? ""),
    order_number: String(c(1) ?? ""),
    mechanic_id: String(c(2) ?? ""),
    status: String(c(3) ?? "draft") as any,
    items: (() => { try { return JSON.parse(String(c(4) ?? "[]")); } catch { return []; } })(),
    parts_cost: Number(c(5) ?? 0),
    total: Number(c(6) ?? 0),
    labour: Number(c(7) ?? 0),
    notes: String(c(8) ?? ""),
    rejected_reason: c(9) ? String(c(9)) : null,
    discord_message_id: c(10) ? String(c(10)) : null,
    created_at: String(c(11) ?? ""),
    approved_at: c(12) ? String(c(12)) : null,
    approved_by: c(13) ? String(c(13)) : null,
    completed_at: c(14) ? String(c(14)) : null,
  };
}

export function rowToTimeclock(row: unknown): import("./types.js").Timeclock {
  const c = (i: number) => cell(row, i);
  return {
    id: String(c(0) ?? ""),
    mechanic_id: String(c(1) ?? ""),
    clock_in_time: String(c(2) ?? ""),
    clock_out_time: c(3) ? String(c(3)) : null,
    duration_minutes: Number(c(4) ?? 0),
    approved_by: c(5) ? String(c(5)) : null,
    status: String(c(6) ?? "pending") as any,
    notes: c(7) ? String(c(7)) : null,
    created_at: String(c(8) ?? ""),
  };
}
