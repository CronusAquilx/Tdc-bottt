---
name: TDC Bot Architecture
description: Core design decisions for the Tokyo Drift Customs Discord bot — commission math, order flow, timeclock design, catalog structure
---

## Commission
- commission = `order.labour * commission_rate` (NOT total — labour only)
- Default rate: 0.3 (30%) stored in `profiles.commission_rate`
- Always display commission on every completed order embed

## Order Flow
- draft → complete (no approve/reject, no manager gate)
- On "Complete Order": status = 'complete', posted to mechanic's `sales_channel_id`
- "Create New Order" button (customId `order:newpanel`) pinned in each sales channel
- Parts/labour/total auto-calculated from catalog on item select; labour editable via `order:editlabour:ID` button → modal `order:setlabour:ID`
- `pay` command marks orders `paid` from `status IN ('complete','approved')`

## Timeclock
- Panel buttons: `clockin:panel` / `clockout:panel` in `#tdc-timeclock` channel
- Clock-in posts a new message to timeclock channel with `<t:UNIX:R>` (live Discord timer)
- Clock-out EDITS that same message (stored in `clock_message_id` / `clock_channel_id` DB cols)
- `/clock in` / `/clock out` commands also supported as fallback

## Catalog
- 32 items in `app_settings` key `parts_catalog` (JSON)
- Each item: `{ label, category, price, cost, labour }`
- `parts_cost = sum(item.cost)`, `labour = sum(item.labour)`, `total = sum(item.price)`
- Categories: Repair, Brakes, Engine, Suspension, Transmission, Turbo, Visual & Body, Neon & Lighting, Extras

## DB Column Indices (important for rowToOrder / rowToTimeclock)
- timeclock: col 9 = clock_message_id, col 10 = clock_channel_id
- guild_config: col 9 = timeclock_channel_id

## Commands Registered
/order /crew /clock /mysales /pay /job /setup /settings /help /payout

## Why
- No approve/reject reduces friction — mechanics complete orders directly
- Sales channels per mechanic keep orders organized and private
- Discord <t:UNIX:R> timestamps update in real-time without any polling
