import { Router } from "express";
import { createClient } from "@libsql/client";
import path from "path";

const router = Router();

const db = createClient({
  url: `file:${path.join(__dirname, "../../discord-bot/data/tdc.db")}`
});

function parseRaffle(row: unknown[]) {
  return {
    id:           String(row[0] ?? ""),
    guild_id:     String(row[1] ?? ""),
    channel_id:   String(row[2] ?? ""),
    message_id:   row[3] ? String(row[3]) : null,
    title:        String(row[4] ?? ""),
    description:  String(row[5] ?? ""),
    prizes:       (() => { try { return JSON.parse(String(row[6] ?? "[]")); } catch { return []; } })(),
    winner_count: Number(row[7] ?? 1),
    ends_at:      row[8] ? String(row[8]) : null,
    started_by:   String(row[9] ?? ""),
    status:       String(row[10] ?? "active"),
    winners:      (() => { try { return JSON.parse(String(row[11] ?? "[]")); } catch { return []; } })(),
  };
}

router.get("/raffles", async (_req, res) => {
  try {
    const r = await db.execute(
      "SELECT * FROM raffles ORDER BY rowid DESC LIMIT 20"
    );
    res.json({ raffles: r.rows.map(row => parseRaffle(row as unknown[])) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/raffles/:id", async (req, res) => {
  try {
    const r = await db.execute({
      sql: "SELECT * FROM raffles WHERE id = ?",
      args: [req.params.id]
    });
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ raffle: parseRaffle(r.rows[0] as unknown[]) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/raffles/:id/entries", async (req, res) => {
  try {
    const r = await db.execute({
      sql: "SELECT user_id FROM raffle_entries WHERE raffle_id = ?",
      args: [req.params.id]
    });
    const entries = r.rows.map(row => String((row as unknown[])[0]));
    res.json({ entries, count: entries.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
