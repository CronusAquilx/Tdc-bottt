---
name: Commission Calculation Fix
description: Why SINCE_RESET_SQL uses created_at, not completed_at, and how to recover a dropped pay period
---

## The Rule
`SINCE_RESET_SQL` in `draftbuttons.ts` must filter by `created_at`, not `COALESCE(completed_at, created_at)`.

## Why
`orderpay:confirm` runs `UPDATE orders SET status = 'paid', completed_at = datetime('now')`. This overwrites the original `completed_at` timestamp with the current time. If `order_number_reset_ts` is later set to any time AFTER the original completion but BEFORE the new `datetime('now')`, those orders silently fall out of the commission window. Using `created_at` (which is immutable) prevents this.

## How to Apply
- The commission query in `draftbuttons.ts` uses `SINCE_RESET_SQL` — keep it as `datetime(created_at) >= datetime(order_number_reset_ts)`.
- `processPayall` and `orderpay:confirm` both already use `DATE(created_at) >= ws` to find orders — this is consistent.

## Recovery Tool
If `order_number_reset_ts` gets set to a too-recent date (dropping commissions), go to Admin Panel → Payroll → **🔧 Fix Pay Period** button. Enter the correct start date (YYYY-MM-DD, e.g. Monday of the current week). This resets `order_number_reset_ts` to midnight of that date, recovering all orders created on or after it.
