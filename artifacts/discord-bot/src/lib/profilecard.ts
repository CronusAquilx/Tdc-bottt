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

const RANK_CONFIG: Record<CrewRank, {
  label: string;
  accent: string;
  stripe: string;
  badge: string;
}> = {
  owner:    { label: "OWNER",    accent: "#d4a017", stripe: "#b8860b", badge: "#7a5800" },
  manager:  { label: "MANAGER",  accent: "#9b59b6", stripe: "#7d3c98", badge: "#4a235a" },
  trainer:  { label: "TRAINER",  accent: "#2980b9", stripe: "#1a6fa0", badge: "#0f3d5c" },
  mechanic: { label: "MECHANIC", accent: "#27ae60", stripe: "#1e8449", badge: "#145a32" },
};

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  online:   { color: "#2ecc71", label: "ACTIVE"   },
  offline:  { color: "#95a5a6", label: "OFFLINE"  },
  on_break: { color: "#f39c12", label: "ON BREAK" },
};

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

function rr(ctx: any, x: number, y: number, w: number, h: number, r: number) {
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

export function drawProfileCard(data: ProfileCardData): Buffer {
  const W = 680;
  const H = 380;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const rank = (data.rank ?? "mechanic") as CrewRank;
  const cfg  = RANK_CONFIG[rank] ?? RANK_CONFIG.mechanic;
  const sc   = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.offline;

  // ── Card background ─────────────────────────────────────────────────────────
  rr(ctx, 0, 0, W, H, 16);
  ctx.fillStyle = "#1a1a2e";
  ctx.fill();

  // ── Top colour bar (rank stripe) ────────────────────────────────────────────
  rr(ctx, 0, 0, W, 60, 16);
  ctx.fillStyle = cfg.stripe;
  ctx.fill();
  // Square off the bottom corners of the stripe
  ctx.fillRect(0, 44, W, 16);

  // ── TDC logo text in stripe ─────────────────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.font = "bold 42px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("TDC", W - 20, 30);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("TOKYO DRIFT CUSTOMS", 20, 20);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "11px sans-serif";
  ctx.fillText("CREW IDENTIFICATION", 20, 40);

  // ── Left panel (avatar area) ─────────────────────────────────────────────────
  const panelX = 20;
  const panelY = 78;
  const panelW = 160;
  const panelH = 272;

  rr(ctx, panelX, panelY, panelW, panelH, 10);
  ctx.fillStyle = "#16213e";
  ctx.fill();

  rr(ctx, panelX, panelY, panelW, panelH, 10);
  ctx.strokeStyle = cfg.accent + "55";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── Avatar circle ────────────────────────────────────────────────────────────
  const avX = panelX + panelW / 2;
  const avY = panelY + 80;
  const avR = 52;

  // Circle border
  ctx.beginPath();
  ctx.arc(avX, avY, avR + 3, 0, Math.PI * 2);
  ctx.strokeStyle = cfg.accent;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // Circle fill
  ctx.beginPath();
  ctx.arc(avX, avY, avR, 0, Math.PI * 2);
  ctx.fillStyle = cfg.badge;
  ctx.fill();

  // Initials
  const initials = data.displayName.split(/\s+/).map(w => w[0] ?? "").join("").toUpperCase().slice(0, 2) || "?";
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${avR * 0.7}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, avX, avY);

  // ── Status badge ─────────────────────────────────────────────────────────────
  const badgeY = avY + avR + 14;
  rr(ctx, avX - 44, badgeY - 10, 88, 22, 11);
  ctx.fillStyle = sc.color + "22";
  ctx.fill();
  rr(ctx, avX - 44, badgeY - 10, 88, 22, 11);
  ctx.strokeStyle = sc.color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Dot
  ctx.beginPath();
  ctx.arc(avX - 30, badgeY + 1, 4, 0, Math.PI * 2);
  ctx.fillStyle = sc.color;
  ctx.fill();

  ctx.fillStyle = sc.color;
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sc.label, avX + 8, badgeY + 1);

  // ── Rank tag ─────────────────────────────────────────────────────────────────
  const rankY = avY + avR + 46;
  rr(ctx, avX - 50, rankY - 11, 100, 24, 12);
  ctx.fillStyle = cfg.accent;
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`★  ${cfg.label}`, avX, rankY + 1);

  // ── Member since ─────────────────────────────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`Member since ${data.memberSince}`, avX, panelY + panelH - 10);

  // ── Right panel ───────────────────────────────────────────────────────────────
  const rx = 198;
  const rw = W - rx - 20;

  // ── Name block ───────────────────────────────────────────────────────────────
  const nameSize = data.displayName.length > 16 ? 28 : 34;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(data.displayName.slice(0, 22), rx, 76);

  // Thin accent line under name
  ctx.fillStyle = cfg.accent;
  ctx.fillRect(rx, 76 + nameSize + 6, 200, 2);

  // ID line
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(`ID: ${data.discordId}`, rx, 76 + nameSize + 14);

  // ── 4-stat grid ──────────────────────────────────────────────────────────────
  const stats = [
    { label: "COMMISSION",  value: `${(data.commissionRate * 100).toFixed(0)}%` },
    { label: "HRS / WEEK",  value: `${data.hoursThisWeek.toFixed(1)}h`         },
    { label: "ORDERS / WK", value: `${data.ordersThisWeek}`                    },
    { label: "TOTAL REV",   value: money(data.totalRevenue)                     },
  ];

  const colW    = Math.floor((rw - 10) / 2);
  const rowH    = 74;
  const gridTop = 148;

  stats.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bx  = rx + col * (colW + 10);
    const by  = gridTop + row * (rowH + 8);

    // Card background
    rr(ctx, bx, by, colW, rowH, 8);
    ctx.fillStyle = "#16213e";
    ctx.fill();
    rr(ctx, bx, by, colW, rowH, 8);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Left accent strip
    rr(ctx, bx, by, 4, rowH, 4);
    ctx.fillStyle = cfg.accent;
    ctx.fill();

    // Value
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(s.value, bx + 16, by + 12);

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "bold 9px sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText(s.label, bx + 16, by + rowH - 10);
  });

  // ── Bottom bar ────────────────────────────────────────────────────────────────
  const bbY = H - 30;
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, bbY, W, 30);

  // Left line
  ctx.fillStyle = cfg.stripe;
  ctx.fillRect(0, bbY, 4, 30);

  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("東京ドリフトカスタム  ·  Built Different. Driven Hard.", 14, bbY + 15);

  // ── Outer card border ─────────────────────────────────────────────────────────
  rr(ctx, 0, 0, W, H, 16);
  ctx.strokeStyle = cfg.accent + "44";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  return canvas.toBuffer("image/png") as unknown as Buffer;
}
