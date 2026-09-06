---
name: TDC Render Reliability
description: Durable reliability rules for the Discord bot running as a long-lived Render worker.
---

The Discord bot must treat an unhealthy gateway or unhandled async failure as a process-recovery event, not merely a log message.

**Why:** A healthy HTTP/port check can remain available while Discord interactions expire or the gateway session has stopped delivering events. Historical Render logs also showed interaction timeouts and order-number races during long-running service periods.

**How to apply:** Keep gateway state observable, allow Discord.js to reconnect during short interruptions, and let the process exit so Render can restart it after an invalidated session, persistent unhealthy gateway state, uncaught exception, or unhandled rejection. Serialize local sequence allocation when multiple interactions can create records concurrently.