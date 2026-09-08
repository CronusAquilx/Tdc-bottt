---
name: TDC Database Recovery
description: Durable storage and restart recovery requirements for the Discord bot.
---

Business state must live under the configured persistent data directory. SQLite writes are checkpointed after critical payroll and raffle mutations, and rotating database snapshots are saved every ten minutes with startup recovery if the live database file is missing.

**Why:** A process restart or recreated runtime can otherwise lose WAL-only changes or start a fresh empty SQLite file, making paid payroll appear unpaid and causing existing raffle buttons to report “Raffle not found.”

**How to apply:** Keep the Render persistent disk mounted at the same `TDC_DATA_DIR`, do not switch the bot to an ephemeral path, and preserve the snapshot files alongside `tdc.db`.