---
name: TDC Discord interaction acknowledgements
description: Keep deferred Discord interactions from leaving an active “thinking” response.
---

When a Discord interaction has been deferred, every completion, permission-denial, and error path must edit the original deferred response. Sending a follow-up does not resolve the original “thinking” response.

**Why:** Modal and button handlers defer while doing database work; a denial or exception routed to a follow-up can make Discord show a spinner indefinitely.

**How to apply:** In shared permission and interaction error handlers, prefer `editReply` when `deferred` is true; use `followUp` only when the original interaction has already been replied to.
