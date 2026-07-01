---
name: TDC Reset Timestamp Format
description: order_number_reset_ts must use SQLite-compatible format, not ISO-8601 with Z suffix
---

**Rule**: Always save `order_number_reset_ts` as `YYYY-MM-DD HH:MM:SS` UTC, not ISO-8601 with T/Z.

```typescript
// CORRECT — SQLite datetime() parses this identically to datetime('now')
await setSetting("order_number_reset_ts", new Date().toISOString().replace("T", " ").slice(0, 19));

// WRONG — SQLite may return NULL from datetime('2026-06-30T06:19:37.000Z') on older versions
await setSetting("order_number_reset_ts", new Date().toISOString());
```

**Why:** `datetime()` in SQLite is defined to handle `YYYY-MM-DDTHH:MM:SS` but the `.000Z` milliseconds + Z timezone suffix combination is only guaranteed from SQLite 3.38.0+. Using the space-separated format `YYYY-MM-DD HH:MM:SS` matches `datetime('now')` output exactly and works on all versions.

**Where this value is written** (all must use the correct format):
- `buttons.ts` `clear:confirm:all` handler
- `buttons.ts` `payroll:newweek:confirm` handler
- `commands/payall.ts` `processPayall` function

**How to apply:** Any new code that sets `order_number_reset_ts` must use the `.replace("T"," ").slice(0,19)` pattern.
