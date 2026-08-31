---
name: TDC Leaderboard
description: How the leaderboard ranks mechanics, what data it shows, and its time boundary
---

**Ranks by**: `total_labour DESC` (not revenue, not commission)

**Display format per mechanic**:
`$X labour · Y% → $Z commission · N orders`

The formula shown to users: `Commission = Labour × Rate` (or equivalently `Labour = Commission ÷ Rate`)

**Time boundary**: Uses `order_number_reset_ts` SINCE_RESET subquery — same boundary as payroll/commission logic. NOT calendar weekStart. This keeps leaderboard consistent with pay panel after mid-week resets.

```sql
datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))
```

**Order statuses included**: `complete`, `approved`, `paid` (not just `complete`)

**LeaderEntry type** (lib/leaderboard.ts):
```typescript
{ discord_id, display_name, order_count, total_revenue, total_labour, commission_rate }
```

**Stats footer**: Total Orders, Total Labour, Total Commissions (not Total Revenue)

**Why:** Owner wanted leaderboard to show "total labour cost" with formula clarity showing what % of what. Aligning to SINCE_RESET ensures the leaderboard doesn't diverge from pay panel after a clearall.
