---
name: Commission Adjustment Semantics
description: How commission_adjustment and manager_cut_adjustment work — snapshot-based baseline, not override or simple additive
---

## The Rule
`commission_adjustment` is a **snapshot-based baseline**. When `/setpay` is run:
1. The current labour total is snapshotted into `commission_labour_snapshot`
2. Going forward: `weekCommission = adjustment + (totalLabour - snapshot) × rate`
3. If no adjustment is set (adj = 0): `weekCommission = totalLabour × rate`

Same logic for `manager_cut_adjustment` / `manager_labour_snapshot`.

**Why:** The user sets pay mid-week after calculating everyone's earned commission manually. The set amount locks in all past orders, and any new orders after that add on top cleanly.

## Files that implement this formula (must stay in sync)
- `artifacts/discord-bot/src/interactions/draftbuttons.ts` — `getCommissionData()`
- `artifacts/discord-bot/src/commands/mysales.ts`
- `artifacts/discord-bot/src/commands/payall.ts` — summary embed + processing loop
- `artifacts/discord-bot/src/interactions/adminbuttons.ts` — payroll panel display
- `artifacts/discord-bot/src/interactions/modals.ts` — admin payroll setpay modal

## Setpay entrypoints (must snapshot at time of save)
- `artifacts/discord-bot/src/commands/setpay.ts` — `/setpay commission` and `/setpay manager-cut`
- `artifacts/discord-bot/src/interactions/modals.ts` — admin panel modal `admin:payroll:setpay:<id>`

## Payday reset
`processPayall()` in `payall.ts` clears: `commission_adjustment = 0, manager_cut_adjustment = 0, commission_labour_snapshot = 0, manager_labour_snapshot = 0`

## DB columns added
- `profiles.commission_labour_snapshot REAL DEFAULT 0`
- `profiles.manager_labour_snapshot REAL DEFAULT 0`
