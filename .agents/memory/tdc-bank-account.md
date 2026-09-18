---
name: TDC Daily Bank Account
description: Daily bank-balance tracking and reconciliation rules for the Tokyo Drift Customs bot
---

The bank-account check treats each completed car order's recorded `total` as expected bank revenue between two balance logs. The first log is a baseline; later logs compare actual balance change with that revenue and report the expected balance plus any shortfall or surplus. Daily reminders use the configured America/Chicago default unless `TDC_TIMEZONE` is set.

**Why:** Management needs a simple daily reconciliation against the same order totals already recorded by the bot, and the reminder must match the server's operating day rather than UTC.

**How to apply:** Preserve the baseline-plus-revenue comparison when changing bank-account logs, reminders, payday prompts, or order revenue semantics.