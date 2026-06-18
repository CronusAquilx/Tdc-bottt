import { Router } from "express";

const router = Router();

const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";

// ── Bot invite URL ──────────────────────────────────────────────────────────
// Use this as the "OAuth2 Redirect URL" in your Developer Portal
// Permissions: 8 = Administrator (change to a lower value if preferred)
const BOT_PERMISSIONS = "414539927616"; // Manage Channels, Send Messages, Embed Links, Read Message History, Manage Roles, Add Reactions

router.get("/discord/invite", (_req, res) => {
  if (!CLIENT_ID) {
    res.status(503).json({ error: "DISCORD_CLIENT_ID not configured in Replit Secrets" });
    return;
  }
  const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
  res.redirect(url);
});

// ── OAuth2 redirect callback ────────────────────────────────────────────────
// Register this URL in Discord Developer Portal → OAuth2 → Redirects:
//   https://<your-replit-domain>/api/discord/callback
router.get("/discord/callback", (req, res) => {
  const { code, guild_id, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`
      <!DOCTYPE html><html><head><title>Tokyo Drift Customs</title>
      <style>body{font-family:sans-serif;background:#1f2937;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#374151;padding:2rem;border-radius:1rem;max-width:480px;text-align:center}
      h1{color:#e5342b}p{color:#9ca3af}</style></head>
      <body><div class="card">
        <h1>❌ Authorization Failed</h1>
        <p>${error_description ?? error}</p>
        <p>Close this window and try again.</p>
      </div></body></html>
    `);
    return;
  }

  if (code || guild_id) {
    res.status(200).send(`
      <!DOCTYPE html><html><head><title>Tokyo Drift Customs</title>
      <style>body{font-family:sans-serif;background:#1f2937;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#374151;padding:2rem;border-radius:1rem;max-width:480px;text-align:center}
      h1{color:#10b981}.sub{color:#9ca3af;margin-top:.5rem}
      .badge{display:inline-block;background:#e5342b;color:#fff;border-radius:.5rem;padding:.25rem .75rem;font-size:.875rem;margin-top:1rem}</style></head>
      <body><div class="card">
        <h1>🏁 Bot Added Successfully!</h1>
        <p class="sub">Tokyo Drift Customs has been added to your server.</p>
        ${guild_id ? `<div class="badge">Server ID: ${guild_id}</div>` : ""}
        <p class="sub" style="margin-top:1.5rem">Run <strong>/setup status</strong> in your server to get started.</p>
      </div></body></html>
    `);
    return;
  }

  res.status(200).send(`
    <!DOCTYPE html><html><head><title>Tokyo Drift Customs</title>
    <style>body{font-family:sans-serif;background:#1f2937;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#374151;padding:2rem;border-radius:1rem;max-width:480px;text-align:center}
    h1{color:#e5342b}.sub{color:#9ca3af}</style></head>
    <body><div class="card">
      <h1>🔧 Tokyo Drift Customs</h1>
      <p class="sub">Discord bot redirect endpoint is active.</p>
    </div></body></html>
  `);
});

// ── Health check ─────────────────────────────────────────────────────────────
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "Tokyo Drift Customs API", ts: new Date().toISOString() });
});

export default router;
