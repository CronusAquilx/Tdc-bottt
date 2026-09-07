---
name: TDC Payroll Embed Limits
description: Discord message-size constraints relevant to payroll summaries and panels.
---

Payroll summaries must split crew payout lines into multiple embed fields rather than placing the entire crew in one field.

**Why:** Discord rejects an embed field value over 1,024 characters. A summary can work with a small local crew but fail in production as the roster grows, surfacing only the generic interaction error.

**How to apply:** Keep each payroll field comfortably below 1,024 characters and preserve the total embed field count within Discord's limit when adding more summary sections.