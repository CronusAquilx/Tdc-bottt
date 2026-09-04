---
name: TDC Bot Architecture
description: Core design decisions for the Tokyo Drift Customs Discord bot — commission math, crew cut, order flow, timeclock, catalog, role detection
---

## Commission Rules
- **Mechanic** — own completed orders × `commission_rate` (default 30%, per-mechanic from `profiles`).
- **Trainer** — own orders commission + `trainer_crew_rate` (default 10%) × SUM of all OTHER mechanics' completed order labour this pay period.
- **Manager / Owner** — own orders commission + `manager_crew_rate` (default 20%) × SUM of all OTHER mechanics' AND trainers' completed order labour this pay period.
- Crew cut is NEVER from own orders — SQL always filters `mechanic_id != ?`.
- Crew cut field shown on embed **only** for trainer/manager/owner via optional `crewCutInfo` param.

## Central Commission Helper
`getCommissionData(userId, guildId, roleLevel)` in `draftbuttons.ts`.
Returns `{ rate, weekCommission, crewCut, crewCutRate, crewCutLabel }`.
All draft/order view refreshes call this once and pass a `crewCutInfo` object (or `undefined` for mechanics).

## Embed Signatures
- `buildDraftEmbed(order, weekCommission, commissionRate, crewCutInfo?)`
- `buildOrderEmbed(order, mechanicName, weekCommission, commissionRate, crewCutInfo?)`
- `crewCutInfo` shape: `{ amount: number; rate: number; label: string }`

## Role Detection
`detectUserRoleLevel(interaction)` in `roles.ts`:
1. Checks Discord roles via guild_config mapping (owner → manager → trainer → mechanic, highest wins).
2. Falls back to `user_roles` DB table (for manually assigned roles via admin panel).
`requireRole` checks both Discord roles AND user_roles DB.

## Order `role_level` Column
- Stored on the order at creation via `detectUserRoleLevel`.
- Column index 16 in `SELECT *` — `rowToOrder` reads it there (guild_id is at 15).
- Used in crew cut SQL: `role_level = 'mechanic'` for trainer cut; `role_level IN ('mechanic','trainer')` for manager cut.

## Guild Config Crew Rates
- `trainer_crew_rate REAL DEFAULT 0.10` and `manager_crew_rate REAL DEFAULT 0.20` added via `safeAlter` in `db.ts`.
- Set via `setGuildCrewRate(guildId, field, rate)` in `db.ts`.
- Admin panel Config tab row4: "📚 Trainer Cut %" / "👔 Manager Cut %" → modal → `admin:commission:trainerrate/managerrate`.

## Admin: Add User as Trainer/Manager
- Config panel row4: `admin:setrole:assign:trainer/manager` → UserSelectMenu `admin:setrole:pickmember:trainer/manager` → upserts into `user_roles`.
- Handled in `adminbuttons.ts` (show select) + `selects.ts` (handle selection).

## Order Flow
- draft → complete (no approve/reject step).
- On "Complete Order": status = 'complete', posted to mechanic's `sales_channel_id`.
- "Create New Order" button (customId `order:newpanel`) pinned in each sales channel.
- Parts/labour/total auto-calculated from catalog on item select; labour editable via modal.
- `pay` command marks orders `paid` from `status IN ('complete','approved')`.

## Timeclock
- Panel buttons: `clockin:panel` / `clockout:panel` in timeclock channel.
- Clock-in posts new message with `<t:UNIX:R>` (live Discord timer).
- Clock-out EDITS that same message (stored in `clock_message_id` / `clock_channel_id` DB cols).

## Catalog
- Stored in `app_settings` key `parts_catalog` (JSON).
- Each item: `{ label, category, price, cost, labour }`.
- `parts_cost = sum(item.cost)`, `labour = sum(item.labour)`, `total = sum(item.price)`.

## DB Column Indices
- timeclock: col 9 = clock_message_id, col 10 = clock_channel_id
- guild_config: col 9 = timeclock_channel_id; col 16 = trainer_crew_rate; col 17 = manager_crew_rate
- orders: col 15 = guild_id; col 16 = role_level

## Crash Prevention (index.ts)
- `process.on("uncaughtException")` → log + `process.exit(1)` after 500ms so supervisor restarts cleanly.
- `process.on("unhandledRejection")` → log only (Node exits anyway; we just want it in logs).
- Discord events: `Events.Error`, `Events.ShardDisconnect`, `Events.ShardReconnecting`, `Events.ShardResume` all wired up.

## Auto-Payday Double-Fire Prevention
- `firedThisWeek` is in-memory — resets to `false` on process restart. Without DB guard, a crash+restart on Monday 00:00-05 min fires payday twice, wiping all `/setpay` data.
- Fix: check `app_settings.last_auto_payday_date` on each tick. Write the dedup key AFTER successful completion (not before), so a mid-run crash allows the next restart to retry safely (processPayall only touches unpaid orders — idempotent).

## Crew and Payroll Persistence
- Important admin writes (crew membership, role assignment, commission rates, and manual pay adjustments) call a SQLite WAL checkpoint immediately after saving.
- **Why:** A fast bot restart should not depend on the periodic checkpoint interval for newly added crew or pay settings to reach the main database file.
- **How to apply:** Keep using the shared `checkpointDatabase()` helper after future critical profile/payroll writes; do not rely only on the background checkpoint timer.

## /clear Must Reset Labour Snapshots
- When `/clear` runs, it resets `order_number_reset_ts` (starts new pay period) but does NOT reset `commission_labour_snapshot`. This breaks the snapshot formula: new orders after clear won't add on top of the `/setpay` amount until new labour exceeds the old (irrelevant) snapshot.
- Fix: `clear:confirm:all` and `clear:confirm:player` now also reset `commission_labour_snapshot = 0, manager_labour_snapshot = 0`.

## Commission Consistency Rule (critical)
Every pay path MUST use the snapshot formula AND the `order_number_reset_ts` boundary — not `weekStart()` or `DATE(created_at) >= ?`:
```
SINCE_RESET = datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))
commAdj   = profile.commission_adjustment ?? 0
snapshot  = profile.commission_labour_snapshot ?? 0
labourAfter = Math.max(0, totalLabour - snapshot)
commission = commAdj > 0 ? commAdj + labourAfter * rate : totalLabour * rate
```
Files that must use this: `setpay.ts`, `payall.ts`, `draftbuttons.ts` (getCommissionData), `mysales.ts`, `pay.ts`, `buttons.ts` (orderpay:start, orderpay:confirm, pay:confirm, sales:viewdetailed). Using `weekStart()` as query boundary causes divergence after mid-week payday.

## On-Behalf Order Editing (modals.ts)
`refreshDraftView` must pass `order.mechanic_id` (not `interaction.user.id`) and `order.role_level` to `getCommissionData` — otherwise manager editing another mechanic's draft sees wrong commission projection.

## Why
- No approve/reject reduces friction — mechanics complete orders directly.
- Role stored per-order (not per-user) so historical crew cut calculations survive role changes.
- Discord `<t:UNIX:R>` timestamps update in real-time without polling.
