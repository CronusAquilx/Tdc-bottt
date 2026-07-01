---
name: TDC Pay Log Panel
description: Live per-mechanic pay log panel in the payday channel — how it's stored, refreshed, and what buttons it carries
---

**Panel location**: `config.payday_channel_id` (guild_config column)

**Message ID storage**: `app_settings` key `paylogs_panel_msg_id:<guildId>` (guild-scoped to avoid multi-guild collisions)

**Key functions** in `commands/payall.ts`:
- `buildPayLogPanelEmbed(guild?)` — one SQL query with GROUP BY to show all mechanics; shows 💚/🔴 status, week orders, hours, commission formula
- `postPayLogPanel(channel, guild?)` — edits existing pinned panel if found (searches pins for bot message with PAY LOG or PAYROLL in title), otherwise posts new + pins + stores msg ID
- `refreshPayLogPanel(guild)` — fire-and-forget; reads msg ID from app_settings, edits message; if not found, posts fresh panel

**Buttons on the panel** (same customIds as admin panel handlers, so no new handler code needed):
- `admin:payroll:markpaid` / `admin:payroll:markunpaid` — ephemeral user select menu
- `payall:schedulenow` — opens pay-all confirmation
- `admin:payroll:newweek` — opens new week confirmation

**Refresh triggers** (all fire-and-forget via dynamic import):
- `interactions/draftbuttons.ts` — after `order:submit` completion
- `interactions/modals.ts` — after `order:setcustomer` completion
- `interactions/buttons.ts` — after `clear:confirm:all`, `payroll:newweek:confirm`, `payall:confirm`

**Why:** Panel must always reflect current state without managers having to manually refresh. Fire-and-forget pattern means panel failures never block order completion flow.
