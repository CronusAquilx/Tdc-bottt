---
name: TDC Full Crew Sync
description: Command-shape and matching conventions for repairing crew membership and sales-channel links from Discord.
---

The full repair operation is exposed as `/crew sync mode:full` and as the Admin Panel → Staff → Full Crew Sync button. It imports members with the configured mechanic Discord role, skips existing crew entries, and links exact display-name or `sales-display-name` text channels.

**Why:** Discord slash commands cannot mix the existing direct subcommands under `/crew` with a nested `sync full` subcommand, so a named mode option preserves all existing `/crew` commands.

**How to apply:** Keep the full sync idempotent: use the configured mechanic role as the source of truth, do not downgrade existing non-mechanic crew roles, and repair missing channel links without creating or deleting channels.