---
name: TDC Crew Repair Safety
description: Safety boundaries for crew health repair and bulk category channel cleanup.
---

Crew health repair is intentionally non-destructive: it can restore missing mechanic profiles and roles and relink saved mechanics to existing sales channels, but it must not delete profiles, orders, payroll history, or channels.

Bulk category cleanup deletes only channels inside the selected category after an explicit confirmation. The category remains, business history remains, and any deleted channel IDs must be cleared from guild configuration, sales-channel profile links, and timeclock channel references.

Bulk crew onboarding must checkpoint profiles and database roles before starting Discord channel creation. Category selection happens after the roster save, so a slow Discord API call or restart cannot lose newly selected mechanics.

**Why:** Discord channel deletion is irreversible, while crew and payroll data must survive administrative cleanup and bot restarts.

**How to apply:** Keep future repair actions additive and require a confirmation for channel deletion. Report unresolved missing sales channels rather than silently creating or deleting channels.