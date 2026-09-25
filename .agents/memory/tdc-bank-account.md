---
name: TDC Daily Bank Account
description: Daily bank-balance tracking and reconciliation rules for the Tokyo Drift Customs bot
---

The bank-account check treats each completed car order's recorded `total` as expected bank revenue and bot-recorded payouts as bank outflows between two balance logs. The first log is a baseline; later logs compare actual change against order revenue minus payouts. Daily reminders use the configured America/Chicago default unless `TDC_TIMEZONE` is set. Logging the balance or processing payday suppresses another bank reminder for that local date; the next daily check can ping the following day.

**Why:** Paying crew reduces the bank balance, so reconciliation must subtract recorded payouts or they appear as unexplained shortfalls. Reminder timing should follow the server's operating day and avoid repeat same-day pings.

**How to apply:** Preserve the baseline-plus-revenue-minus-payouts comparison when changing bank-account logs, reminder scheduling, payday processing, or order revenue semantics.