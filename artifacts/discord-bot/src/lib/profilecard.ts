import { createCanvas } from "@napi-rs/canvas";

export type CrewRank = "owner" | "manager" | "trainer" | "mechanic";

interface ProfileCardData {
  displayName: string;
  rank: CrewRank;
  discordId: string;
  commissionRate: number;
  hoursThisWeek: number;
  ordersThisWeek: number;
  totalRevenue: number;
  status: string;
  memberSince: string;
}

const RANK_CONFIG: Record<CrewRank, { label: string; color: string; badge: string; accent: string }> = {
  owner:    { label: "OWNER",    color: "#ffd700", badge: "👑", accent: "#b8860b" },
  manager:  { label: "MANAGER",  color: "#a855f7", badge: "🔧", accent: "#6b21a8" },
  trainer:  { label: "TRAINER",  color: "#00d4ff", badge: "📚", accent: "#0369a1" },
  mechanic: { label: "MECHANIC", color: "#00ff88", badge: "🔩", accent: "#166534" },
};

const STATUS_COLOR: Record<string, string> = {
  online:   "#00ff88",
  offline:  "#555555",
  on_break: "#ffd600",
};

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

export function drawProfileCard(data: ProfileCardData): Buffer {
  const W = 640;
  const H = 360;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const rank = (data.rank ?? "mechanic") as CrewRank;
  const cfg = RANK_CONFIG[rank] ?? RANK_CONFIG.mechanic;
  const statusColor = STATUS_COLOR[data.status] ?? "#555555";

  // ── Card background ────────────────────────────────────────────────────────
  // Dark base
  ctx.fillStyle = "#060a12";
  ctx.fillRect(0, 0, W, H);

  // Atmospheric gradient from rank colour
  const atmo = ctx.createRadialGradient(W * 0.15, H * 0.25, 0, W * 0.15, H * 0.25, W * 0.75);
  atmo.addColorStop(0, cfg.color + "28");
  atmo.addColorStop(0.5, cfg.color + "0a");
  atmo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = atmo;
  ctx.fillRect(0, 0, W, H);

  // ── Card border ────────────────────────────────────────────────────────────
  const RADIUS = 16;
  ctx.save();
  roundRect(ctx, 2, 2, W - 4, H - 4, RADIUS);
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 2.5;
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 14;
  ctx.stroke();
  ctx.restore();

  // Inner border accent
  roundRect(ctx, 6, 6, W - 12, H - 12, RADIUS - 3);
  ctx.strokeStyle = cfg.color + "30";
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Top rank bar ───────────────────────────────────────────────────────────
  const barGrad = ctx.createLinearGradient(0, 0, W, 0);
  barGrad.addColorStop(0, cfg.color + "cc");
  barGrad.addColorStop(0.4, cfg.color + "66");
  barGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, W, 38);

  // Rank label
  ctx.save();
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "#000000aa";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`TOKYO DRIFT CUSTOMS  ·  ${cfg.label}`, 20, 19);
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`TOKYO DRIFT CUSTOMS  ·  ${cfg.label}`, 19, 18);
  ctx.restore();

  // TDC logo right
  ctx.save();
  ctx.font = "bold 12px sans-serif";
  ctx.fillStyle = cfg.color;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 8;
  ctx.fillText("TDC", W - 18, 19);
  ctx.restore();

  // ── Left section: avatar placeholder + status ──────────────────────────────
  const avatarX = 42;
  const avatarY = 72;
  const avatarR = 52;

  // Avatar glow ring
  ctx.save();
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 20;
  ctx.beginPath();
  ctx.arc(avatarX + avatarR, avatarY + avatarR, avatarR + 3, 0, 2 * Math.PI);
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth   = 3;
  ctx.stroke();
  ctx.restore();

  // Avatar circle bg
  const avGrad = ctx.createRadialGradient(avatarX + avatarR, avatarY + avatarR, 0, avatarX + avatarR, avatarY + avatarR, avatarR);
  avGrad.addColorStop(0, cfg.color + "33");
  avGrad.addColorStop(1, "#0d0d1a");
  ctx.beginPath();
  ctx.arc(avatarX + avatarR, avatarY + avatarR, avatarR, 0, 2 * Math.PI);
  ctx.fillStyle = avGrad;
  ctx.fill();

  // Initials
  ctx.save();
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 12;
  ctx.fillStyle = cfg.color;
  ctx.font = `bold ${avatarR * 0.72}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    data.displayName.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2),
    avatarX + avatarR,
    avatarY + avatarR
  );
  ctx.restore();

  // Status dot
  const dotX = avatarX + avatarR * 2 - 10;
  const dotY = avatarY + avatarR * 2 - 10;
  ctx.save();
  (ctx as any).shadowColor = statusColor;
  (ctx as any).shadowBlur  = 10;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 9, 0, 2 * Math.PI);
  ctx.fillStyle = statusColor;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 9, 0, 2 * Math.PI);
  ctx.strokeStyle = "#060a12";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // ── Right section: name + details ─────────────────────────────────────────
  const infoX = 168;
  const infoY = 60;

  // Name
  ctx.save();
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 10;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(data.displayName.slice(0, 20), infoX, infoY);
  ctx.restore();

  // Rank badge pill
  const rankPillX = infoX;
  const rankPillY = infoY + 38;
  const pillW = 110;
  const pillH = 24;
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, rankPillX, rankPillY, pillW, pillH, 12);
  ctx.fillStyle = cfg.color + "33";
  ctx.fill();
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = cfg.color;
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 8;
  ctx.fillText(cfg.label, rankPillX + pillW / 2, rankPillY + pillH / 2);
  ctx.restore();

  // Status text
  ctx.fillStyle = statusColor;
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const statusLabel = data.status === "on_break" ? "ON BREAK" : data.status.toUpperCase();
  ctx.fillText(`● ${statusLabel}`, rankPillX + pillW + 12, rankPillY + 5);

  // ── Stats grid ──────────────────────────────────────────────────────────────
  const stats = [
    { label: "COMMISSION", value: `${(data.commissionRate * 100).toFixed(0)}%` },
    { label: "HRS THIS WEEK", value: `${data.hoursThisWeek.toFixed(1)}h` },
    { label: "ORDERS / WEEK", value: `${data.ordersThisWeek}` },
    { label: "TOTAL REVENUE", value: money(data.totalRevenue) },
  ];

  const gridStartX = infoX;
  const gridStartY = infoY + 80;
  const colW = 118;
  const rowH = 64;

  stats.forEach((s, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const bx = gridStartX + col * (colW + 10);
    const by = gridStartY + row * rowH;

    // Stat card bg
    ctx.save();
    roundRect(ctx, bx, by, colW, 56, 8);
    ctx.fillStyle = cfg.color + "12";
    ctx.fill();
    ctx.strokeStyle = cfg.color + "30";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Value
    ctx.save();
    ctx.fillStyle = cfg.color;
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    (ctx as any).shadowColor = cfg.color;
    (ctx as any).shadowBlur  = 8;
    ctx.fillText(s.value, bx + colW / 2, by + 8);
    ctx.restore();

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(s.label, bx + colW / 2, by + 35);
  });

  // ── Vertical divider ──────────────────────────────────────────────────────
  const divGrad = ctx.createLinearGradient(148, 50, 148, H - 30);
  divGrad.addColorStop(0, "rgba(0,0,0,0)");
  divGrad.addColorStop(0.3, cfg.color + "55");
  divGrad.addColorStop(0.7, cfg.color + "55");
  divGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(148, 50);
  ctx.lineTo(148, H - 30);
  ctx.strokeStyle = divGrad;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Bottom bar: member since + ID ─────────────────────────────────────────
  const barY = H - 36;
  const footGrad = ctx.createLinearGradient(0, barY, W, barY);
  footGrad.addColorStop(0, cfg.color + "22");
  footGrad.addColorStop(0.5, cfg.color + "11");
  footGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = footGrad;
  ctx.fillRect(0, barY, W, 36);

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font      = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`Member since ${data.memberSince}`, 18, barY + 18);

  ctx.fillStyle = cfg.color + "88";
  ctx.font      = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`ID: ${data.discordId}`, W - 18, barY + 18);

  return canvas.toBuffer("image/png") as unknown as Buffer;
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
