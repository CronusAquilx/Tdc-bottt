---
name: TDC Portal API Operations
description: Cross-service settings required for the private staff portal proxy and activation links.
---

The website API service proxies portal requests to the Discord bot using `WEB_API_SECRET`; both processes must receive the same value. If the API service was already running when the secret was added or changed, restart it (and the bot) so both workers load the current secret.

In production, set `TDC_BOT_API_URL` to the bot API service URL and `PORTAL_BASE_URL` to the website origin. Development uses a local bot fallback and accepts the trusted preview origin.

**Why:** The portal spans separate web/API and bot processes. A secret existing in project settings does not prove a running service loaded it, and activation links need the correct website origin.

**How to apply:** When portal login or invites fail, verify secret presence without exposing its value, restart both relevant services after secret changes, and confirm the production URLs are configured.
