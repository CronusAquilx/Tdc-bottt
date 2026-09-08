---
name: TDC Database Recovery
description: Durable storage and restart recovery requirements for the Discord bot.
---

Business state must live under the configured persistent data directory. SQLite uses full synchronous durability, critical payroll, raffle, crew-profile, and sales-channel-link mutations create immediate recovery snapshots, and a rotating snapshot is also saved every minute with startup recovery if the live database file is missing.

**Why:** A process restart or recreated runtime can otherwise lose WAL-only changes or start a fresh empty SQLite file, making paid payroll appear unpaid and causing existing raffle buttons to report “Raffle not found.”

**How to apply:** Keep the Render persistent disk mounted at the same `TDC_DATA_DIR`, do not switch the bot to an ephemeral path, and preserve the snapshot files alongside `tdc.db`. Treat the live database and its recovery snapshots as one data set. Crew onboarding must save the profile before channel creation and save each resulting `sales_channel_id`.