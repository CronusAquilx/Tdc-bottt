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

const TDC_CATALOG = JSON.stringify({
  categories: ["Vehicle Packages", "Performance", "Repair", "Visual & Body", "Neon & Lighting", "Extras"],
  items: [
    // ── Vehicle Packages ──────────────────────────────────────────────────
    { label: "Bike Performance",             category: "Vehicle Packages", price: 145000, cost: 25000, labour: 120000 },
    { label: "Bike Full Custom + Cosmetics", category: "Vehicle Packages", price: 180000, cost: 20000, labour: 160000 },
    { label: "Car Performance",              category: "Vehicle Packages", price: 175000, cost: 30000, labour: 145000 },
    { label: "Car Full Custom + Cosmetics",  category: "Vehicle Packages", price: 210000, cost: 25000, labour: 185000 },
    // ── Performance (Brakes, Engine, Suspension, Transmission, Turbo) ─────
    { label: "Brakes 1",            category: "Performance",     price: 8100,  cost: 2500,  labour: 5600  },
    { label: "Brakes 2",            category: "Performance",     price: 12500, cost: 5000,  labour: 7500  },
    { label: "Brakes 3",            category: "Performance",     price: 16900, cost: 7500,  labour: 9400  },
    { label: "Engine 1",            category: "Performance",     price: 25000, cost: 10000, labour: 15000 },
    { label: "Engine 2",            category: "Performance",     price: 42500, cost: 20000, labour: 22500 },
    { label: "Engine 3",            category: "Performance",     price: 60000, cost: 30000, labour: 30000 },
    { label: "Engine 4",            category: "Performance",     price: 70000, cost: 40000, labour: 30000 },
    { label: "Suspension 1",        category: "Performance",     price: 5300,  cost: 3000,  labour: 2300  },
    { label: "Suspension 2",        category: "Performance",     price: 10500, cost: 6000,  labour: 4500  },
    { label: "Suspension 3",        category: "Performance",     price: 15800, cost: 9000,  labour: 6800  },
    { label: "Suspension 4",        category: "Performance",     price: 21000, cost: 12000, labour: 9000  },
    { label: "Transmission 1",      category: "Performance",     price: 8800,  cost: 5000,  labour: 3800  },
    { label: "Transmission 2",      category: "Performance",     price: 17500, cost: 10000, labour: 7500  },
    { label: "Transmission 3",      category: "Performance",     price: 26300, cost: 15000, labour: 11300 },
    { label: "Turbo",               category: "Performance",     price: 40000, cost: 10000, labour: 30000 },
    // ── Repair ────────────────────────────────────────────────────────────
    { label: "Full Repair",         category: "Repair",          price: 800,   cost: 100,   labour: 700   },
    // ── Visual & Body ─────────────────────────────────────────────────────
    { label: "Primary Color",       category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Secondary Color",     category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Respray Dashboard",   category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Interior",            category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Respray (Primary)",   category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Respray (Secondary)", category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Respray Wheels",      category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    { label: "Pearlescent",         category: "Visual & Body",   price: 11500, cost: 1000,  labour: 10500 },
    // ── Neon & Lighting ───────────────────────────────────────────────────
    // Each neon side is sold individually; Neon Color is a separate colour-change charge
    { label: "Neon Front",          category: "Neon & Lighting", price: 1000,  cost: 250,   labour: 750   },
    { label: "Neon Back",           category: "Neon & Lighting", price: 1000,  cost: 250,   labour: 750   },
    { label: "Neon Left",           category: "Neon & Lighting", price: 1000,  cost: 250,   labour: 750   },
    { label: "Neon Right",          category: "Neon & Lighting", price: 1000,  cost: 250,   labour: 750   },
    { label: "Neon Color",          category: "Neon & Lighting", price: 1000,  cost: 250,   labour: 750   },
    { label: "Xenon Lighting",      category: "Neon & Lighting", price: 2100,  cost: 1000,  labour: 1100  },
    // ── Extras ────────────────────────────────────────────────────────────
    { label: "Horns",               category: "Extras",          price: 1600,  cost: 500,   labour: 1100  },
    { label: "Hydraulics",          category: "Extras",          price: 1600,  cost: 500,   labour: 1100  },
    { label: "Plate Style",         category: "Extras",          price: 1600,  cost: 500,   labour: 1100  },
    { label: "Wheels",              category: "Extras",          price: 3900,  cost: 500,   labour: 3400  },
    { label: "Tire Smoke",          category: "Extras",          price: 4000,  cost: 1000,  labour: 3000  },
    { label: "Window Tinting",      category: "Extras",          price: 2100,  cost: 1000,  labour: 1100  },
  ]
});

export async function initDb() {
  // Enable WAL mode + busy timeout so concurrent reads/writes don't deadlock
  await db.execute("PRAGMA journal_mode=WAL");
  await db.execute("PRAGMA busy_timeout=5000");

  await exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      discord_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      sales_channel_id TEXT,
      commission_rate REAL NOT NULL DEFAULT 0.3,
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
      status TEXT NOT NULL DEFAULT 'approved',
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
    );

    CREATE TABLE IF NOT EXISTS loa_requests (
      id TEXT PRIMARY KEY,
      mechanic_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      start_date TEXT NOT NULL,
      return_date TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      discord_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raffles (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      prizes TEXT NOT NULL DEFAULT '[]',
      winner_count INTEGER NOT NULL DEFAULT 1,
      ends_at TEXT,
      started_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      winners TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raffle_entries (
      raffle_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (raffle_id, user_id)
    )
  `);

  // Safe migrations
  await safeAlter("ALTER TABLE guild_config ADD COLUMN owner_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN manager_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN trainer_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN mechanic_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN timeclock_channel_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN loa_channel_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN raffle_channel_id TEXT");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN clock_message_id TEXT");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN clock_channel_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN leaderboard_channel_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN training_channel_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN needs_training_role_id TEXT");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN payday_channel_id TEXT");
  await safeAlter("ALTER TABLE profiles ADD COLUMN in_city_id TEXT");
  await safeAlter("ALTER TABLE profiles ADD COLUMN manager_id TEXT");
  await safeAlter("ALTER TABLE profiles ADD COLUMN manager_override_rate REAL DEFAULT 0.20");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN warned_at TEXT");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN stayed_in_at TEXT");
  await safeAlter("ALTER TABLE orders ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''");
  await safeAlter("ALTER TABLE orders ADD COLUMN role_level TEXT NOT NULL DEFAULT 'mechanic'");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN trainer_crew_rate REAL DEFAULT 0.10");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN manager_crew_rate REAL DEFAULT 0.20");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN clocklog_channel_id TEXT");
  await safeAlter("ALTER TABLE profiles ADD COLUMN commission_adjustment REAL DEFAULT 0");
  await safeAlter("ALTER TABLE profiles ADD COLUMN manager_cut_adjustment REAL DEFAULT 0");
  await safeAlter("ALTER TABLE profiles ADD COLUMN commission_labour_snapshot REAL DEFAULT 0");
  await safeAlter("ALTER TABLE profiles ADD COLUMN manager_labour_snapshot REAL DEFAULT 0");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN warn_msg_id TEXT");
  await safeAlter("ALTER TABLE timeclock ADD COLUMN warn_chan_id TEXT");
  await safeAlter("ALTER TABLE orders ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''");
  await safeAlter("ALTER TABLE profiles ADD COLUMN current_pay_status TEXT NOT NULL DEFAULT 'pending'");
  await safeAlter("ALTER TABLE guild_config ADD COLUMN lifetime_earnings_channel_id TEXT");
  await safeAlter("ALTER TABLE orders ADD COLUMN customer_total_override REAL");

  // Close only sessions that have been open for more than 8 hours — these are genuinely stale
  // (bot was down for a long shift). Recent sessions survive quick restarts and deploys so
  // mechanics who are actively clocked in don't get kicked out unexpectedly.
  await db.execute({
    sql: `UPDATE timeclock
          SET clock_out_time = datetime('now'),
              duration_minutes = ROUND((strftime('%s','now') - strftime('%s', REPLACE(clock_in_time,' ','T') || 'Z')) / 60.0, 2),
              status = 'approved',
              warned_at = NULL, stayed_in_at = NULL
          WHERE clock_out_time IS NULL
          AND datetime(COALESCE(clock_in_time, '2000-01-01')) < datetime('now', '-8 hours')`,
    args: []
  });
  // Only mark offline mechanics whose session was just closed (not those still clocked in)
  await db.execute({
    sql: `UPDATE profiles SET status = 'offline'
          WHERE status IN ('online','on_break')
          AND discord_id NOT IN (SELECT DISTINCT mechanic_id FROM timeclock WHERE clock_out_time IS NULL)`,
    args: []
  });

  // Seed / update catalog
  await db.execute({ sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", args: ["parts_catalog", TDC_CATALOG] });
  await db.execute({ sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)", args: ["commission_default", "0.3"] });

  // Force-flush the WAL into the main .db file right now so tdc.db is always
  // up-to-date when git checkpoints run.  Without this, all writes since the last
  // checkpoint live only in tdc.db-wal (which is gitignored) and are lost if the
  // container is ever rebuilt from git.
  try { await db.execute("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* non-fatal */ }

  // Schedule a WAL checkpoint every 3 minutes so the main file stays current.
  setInterval(async () => {
    try { await db.execute("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* ignore */ }
  }, 3 * 60 * 1000);

  console.log("[TDC] Database initialized.");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// ── In-memory setting cache for hot-path reads (catalog, commission_default) ──
const _settingCache = new Map<string, { value: string; ts: number }>();
const SETTING_TTL = 60_000; // 60 seconds

export async function getSetting(key: string): Promise<string | null> {
  const cached = _settingCache.get(key);
  if (cached && Date.now() - cached.ts < SETTING_TTL) return cached.value;
  const r = await db.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [key] });
  const value = r.rows[0] ? String(r.rows[0][0]) : null;
  if (value !== null) _settingCache.set(key, { value, ts: Date.now() });
  return value;
}

export function invalidateSettingCache(key?: string) {
  if (key) _settingCache.delete(key);
  else _settingCache.clear();
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.execute({ sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", args: [key, value] });
  invalidateSettingCache(key);
}

export async function getGuildConfig(guildId: string) {
  const r = await db.execute({
    sql: `SELECT guild_id,
                 orders_channel_id, jobs_channel_id, log_channel_id, archive_channel_id,
                 owner_role_id, manager_role_id, trainer_role_id, mechanic_role_id,
                 timeclock_channel_id, loa_channel_id, raffle_channel_id,
                 leaderboard_channel_id, training_channel_id, needs_training_role_id,
                 payday_channel_id, trainer_crew_rate, manager_crew_rate, clocklog_channel_id,
                 lifetime_earnings_channel_id
          FROM guild_config WHERE guild_id = ?`,
    args: [guildId]
  });
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    guild_id:                      String(row[0]  ?? ""),
    orders_channel_id:             row[1]  ? String(row[1])  : null,
    jobs_channel_id:               row[2]  ? String(row[2])  : null,
    log_channel_id:                row[3]  ? String(row[3])  : null,
    archive_channel_id:            row[4]  ? String(row[4])  : null,
    owner_role_id:                 row[5]  ? String(row[5])  : null,
    manager_role_id:               row[6]  ? String(row[6])  : null,
    trainer_role_id:               row[7]  ? String(row[7])  : null,
    mechanic_role_id:              row[8]  ? String(row[8])  : null,
    timeclock_channel_id:          row[9]  ? String(row[9])  : null,
    loa_channel_id:                row[10] ? String(row[10]) : null,
    raffle_channel_id:             row[11] ? String(row[11]) : null,
    leaderboard_channel_id:        row[12] ? String(row[12]) : null,
    training_channel_id:           row[13] ? String(row[13]) : null,
    needs_training_role_id:        row[14] ? String(row[14]) : null,
    payday_channel_id:             row[15] ? String(row[15]) : null,
    trainer_crew_rate:             row[16] != null ? Number(row[16]) : 0.10,
    manager_crew_rate:             row[17] != null ? Number(row[17]) : 0.20,
    clocklog_channel_id:           row[18] ? String(row[18]) : null,
    lifetime_earnings_channel_id:  row[19] ? String(row[19]) : null,
  };
}

export async function setGuildConfig(
  guildId: string,
  field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id" | "timeclock_channel_id" | "loa_channel_id" | "raffle_channel_id" | "leaderboard_channel_id" | "training_channel_id" | "payday_channel_id" | "clocklog_channel_id" | "lifetime_earnings_channel_id",
  channelId: string
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}`,
    args: [guildId, channelId]
  });
}

export async function setGuildCrewRate(
  guildId: string,
  field: "trainer_crew_rate" | "manager_crew_rate",
  rate: number
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}`,
    args: [guildId, rate]
  });
}

export async function setGuildRoleMapping(
  guildId: string,
  level: "owner" | "manager" | "trainer" | "mechanic" | "needs_training",
  roleIds: string[]
): Promise<void> {
  const field = `${level}_role_id`;
  const value = roleIds.filter(Boolean).join(",");
  await db.execute({
    sql: `INSERT INTO guild_config (guild_id, ${field}) VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}`,
    args: [guildId, value]
  });
}

/** Split a comma-separated role ID string into an array of IDs */
export function splitRoleIds(s: string | null | undefined): string[] {
  return (s ?? "").split(",").map(r => r.trim()).filter(Boolean);
}

export async function nextOrderNumber(): Promise<string> {
  // Ensure the sequence row exists
  await db.execute("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('order_seq', '0')");

  // Sync the counter up to the highest order number already in the table.
  // This self-heals if the counter ever falls behind (e.g. after a DB restore
  // or if orders were inserted via a different path).
  await db.execute(
    `UPDATE app_settings
     SET value = CAST(
       MAX(
         CAST(value AS INTEGER),
         COALESCE(
           (SELECT MAX(CAST(SUBSTR(order_number, 5) AS INTEGER))
            FROM orders
            WHERE order_number LIKE 'TDC-%'
              AND LENGTH(order_number) >= 8),
           0
         )
       ) AS TEXT
     )
     WHERE key = 'order_seq'`
  );

  // Atomically increment and read the new value
  const results = await db.batch([
    {
      sql: "UPDATE app_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'order_seq'",
      args: []
    },
    {
      sql: "SELECT value FROM app_settings WHERE key = 'order_seq'",
      args: []
    }
  ], "write");
  const num = parseInt(String(results[1].rows[0]?.[0] ?? "1"), 10);
  return `TDC-${String(num).padStart(4, "0")}`;
}

// NOTE: order_seq is intentionally never reset — it is a globally monotonic counter.
// The pay-period boundary is tracked via order_number_reset_ts in app_settings.

export async function getProfile(discordId: string) {
  const r = await db.execute({ sql: "SELECT discord_id, display_name, sales_channel_id, commission_rate, hours_worked_this_week, status, created_at, in_city_id, manager_id, manager_override_rate, commission_adjustment, manager_cut_adjustment, commission_labour_snapshot, manager_labour_snapshot FROM profiles WHERE discord_id = ?", args: [discordId] });
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    discord_id:                    String(row[0] ?? ""),
    display_name:                  String(row[1] ?? ""),
    sales_channel_id:              row[2] ? String(row[2]) : null,
    commission_rate:               Number(row[3] ?? 0.3),
    hours_worked_this_week:        Number(row[4] ?? 0),
    status:                        String(row[5] ?? "offline"),
    created_at:                    String(row[6] ?? ""),
    in_city_id:                    row[7] ? String(row[7]) : null,
    manager_id:                    row[8] ? String(row[8]) : null,
    manager_override_rate:         Number(row[9] ?? 0.20),
    commission_adjustment:         Number(row[10] ?? 0),
    manager_cut_adjustment:        Number(row[11] ?? 0),
    commission_labour_snapshot:    Number(row[12] ?? 0),
    manager_labour_snapshot:       Number(row[13] ?? 0),
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

function cell(row: unknown, idx: number): unknown {
  if (Array.isArray(row)) return row[idx];
  if (row && typeof row === "object") return (row as Record<string | number, unknown>)[idx];
  return undefined;
}

export function rowToOrder(row: unknown): import("./types.js").Order {
  const c = (i: number) => cell(row, i);
  return {
    id:               String(c(0)  ?? ""),
    order_number:     String(c(1)  ?? ""),
    mechanic_id:      String(c(2)  ?? ""),
    status:           String(c(3)  ?? "draft") as any,
    items:            (() => { try { return JSON.parse(String(c(4) ?? "[]")); } catch { return []; } })(),
    parts_cost:       Number(c(5)  ?? 0),
    total:            Number(c(6)  ?? 0),
    labour:           Number(c(7)  ?? 0),
    notes:            String(c(8)  ?? ""),
    rejected_reason:  c(9)  ? String(c(9))  : null,
    discord_message_id: c(10) ? String(c(10)) : null,
    created_at:       String(c(11) ?? ""),
    approved_at:      c(12) ? String(c(12)) : null,
    approved_by:      c(13) ? String(c(13)) : null,
    completed_at:     c(14) ? String(c(14)) : null,
    role_level:              c(16) ? String(c(16)) : "mechanic",
    customer_name:           c(17) ? String(c(17)) : "",
    customer_total_override: c(18) != null ? Number(c(18)) : null,
  };
}

export function rowToTimeclock(row: unknown): import("./types.js").Timeclock {
  const c = (i: number) => cell(row, i);
  return {
    id:               String(c(0)  ?? ""),
    mechanic_id:      String(c(1)  ?? ""),
    clock_in_time:    String(c(2)  ?? ""),
    clock_out_time:   c(3)  ? String(c(3))  : null,
    duration_minutes: Number(c(4)  ?? 0),
    approved_by:      c(5)  ? String(c(5))  : null,
    status:           String(c(6)  ?? "approved") as any,
    notes:            c(7)  ? String(c(7))  : null,
    created_at:       String(c(8)  ?? ""),
    clock_message_id: c(9)  ? String(c(9))  : null,
    clock_channel_id: c(10) ? String(c(10)) : null,
    warn_msg_id:      c(14) ? String(c(14)) : null,
    warn_chan_id:     c(15) ? String(c(15)) : null,
  };
}
