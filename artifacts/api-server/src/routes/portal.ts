import { Router } from "express";

const router = Router();

router.use("/portal", async (req, res): Promise<void> => {
  const apiKey = process.env.WEB_API_SECRET;
  if (!apiKey) {
    res.status(503).json({ error: "Portal API is not configured" });
    return;
  }

  const configuredUrl = process.env.TDC_BOT_API_URL?.trim();
  const botBaseUrl = configuredUrl || (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5000");
  if (!botBaseUrl) {
    res.status(503).json({ error: "Set TDC_BOT_API_URL to the Discord bot API service" });
    return;
  }

  let target: URL;
  try {
    const base = new URL(botBaseUrl);
    const botPath = req.originalUrl.replace(/^\/api/, "");
    target = new URL(`/api${botPath}`, base);
  } catch {
    res.status(503).json({ error: "TDC_BOT_API_URL must be a valid URL" });
    return;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-forwarded-proto": String(req.headers["x-forwarded-proto"] ?? (req.secure ? "https" : "http")),
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers["x-forwarded-for"]) {
    headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"]);
  }
  if (req.headers.origin) headers["x-portal-origin"] = String(req.headers.origin);
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["content-type"] = String(req.headers["content-type"] ?? "application/json");
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
      redirect: "manual",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    const setCookie = upstream.headers.get("set-cookie");
    if (setCookie) res.setHeader("set-cookie", setCookie);
    res.setHeader("cache-control", "no-store");
    res.status(upstream.status).send(await upstream.text());
  } catch (error) {
    req.log.error({ err: error }, "Portal bot API request failed");
    res.status(502).json({ error: "The crew portal service is unavailable" });
  }
});

export default router;
