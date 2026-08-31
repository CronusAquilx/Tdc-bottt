---
name: TDC Catalog Structure
description: Parts catalog categories, key items, and body-parts pricing rules
---

Categories (in order): Vehicle Packages, Performance, Repair, Visual & Body, Neon & Lighting, Extras

**Vehicle Packages** (new as of July 2026):
- Bike Performance: $145K (cost=$25K, labour=$120K)
- Bike Full Custom + Cosmetics: $180K (cost=$20K, labour=$160K)
- Car Performance: $175K (cost=$30K, labour=$145K)
- Car Full Custom + Cosmetics: $210K (cost=$25K, labour=$185K)

**Neon & Lighting** — individual sides only, no "Neon Kit":
- Neon Front / Back / Left / Right: $1,000 each (cost=$250, labour=$750)
- Neon Color: $500 (cost=$100, labour=$400)
- Xenon Lighting: $2,100

**Extras** (Tire Smoke and Window Tinting live here, NOT in Neon & Lighting):
- Tire Smoke: $4,000 | Window Tinting: $2,100

**Body Parts** (via 🩸 Body Parts button → modal):
- $2,000 per part all-in; cost=$500, labour=$1,500 per part
- stored as category `__extras__` in the order items array

**Catalog delivery**: `INSERT OR REPLACE INTO app_settings` on every `initDb()`, so catalog updates apply on next bot restart.

**Why:** Per-side neon reflects FiveM's actual purchase model. Vehicle packages added for full-build orders. Body parts price raised from $500 to $2K per owner request.

**How to apply:** When adding new catalog items, edit `TDC_CATALOG` in `db.ts`. The Full Build (fullpackage handler) has its own hardcoded copy — update both.
