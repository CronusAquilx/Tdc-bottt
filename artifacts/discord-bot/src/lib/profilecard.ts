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
  label: string; color: string; darkColor: string;
  gradient: [string, string]; tagline: string;
}> = {
  owner:    { label: "OWNER",    color: "#ffd700", darkColor: "#7a5800", gradient: ["#ffd700","#ff8c00"], tagline: "Running the Shop" },
  manager:  { label: "MANAGER",  color: "#c084fc", darkColor: "#4a0080", gradient: ["#c084fc","#7c3aed"], tagline: "Keeping It Together" },
  trainer:  { label: "TRAINER",  color: "#22d3ee", darkColor: "#0369a1", gradient: ["#22d3ee","#0ea5e9"], tagline: "Building the Next Gen" },
  mechanic: { label: "MECHANIC", color: "#4ade80", darkColor: "#166534", gradient: ["#4ade80","#16a34a"], tagline: "On the Grind" },
};

const STATUS_CONFIG: Record<string, { color: string; label: string; dot: string }> = {
  online:   { color: "#4ade80", label: "ONLINE",   dot: "●" },
  offline:  { color: "#6b7280", label: "OFFLINE",  dot: "●" },
  on_break: { color: "#fbbf24", label: "ON BREAK", dot: "●" },
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
  const W = 700;
  const H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const rank = (data.rank ?? "mechanic") as CrewRank;
  const cfg = RANK_CONFIG[rank] ?? RANK_CONFIG.mechanic;
  const sc  = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.offline;

  // ── Background ─────────────────────────────────────────────────────────────
  ctx.fillStyle = "#080c18";
  ctx.fillRect(0, 0, W, H);

  // Diagonal split: left panel darker
  ctx.fillStyle = "#0d1220";
  ctx.fillRect(0, 0, 220, H);

  // Rank colour atmospheric glow top-left
  const glow = ctx.createRadialGradient(110, 120, 0, 110, 120, 240);
  glow.addColorStop(0, cfg.color + "33");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Top-right corner accent glow
  const glow2 = ctx.createRadialGradient(W, 0, 0, W, 0, 280);
  glow2.addColorStop(0, cfg.darkColor + "55");
  glow2.addColorStop(1, "transparent");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ── Card outer border ─────────────────────────────────────────────────────
  ctx.save();
  rr(ctx, 1, 1, W - 2, H - 2, 18);
  ctx.strokeStyle = cfg.color + "88";
  ctx.lineWidth = 1.5;
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 16;
  ctx.stroke();
  ctx.restore();

  // ── Diagonal divider line ─────────────────────────────────────────────────
  const divGrad = ctx.createLinearGradient(220, 0, 220, H);
  divGrad.addColorStop(0, "transparent");
  divGrad.addColorStop(0.3, cfg.color + "cc");
  divGrad.addColorStop(0.7, cfg.color + "cc");
  divGrad.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.moveTo(220, 0);
  ctx.lineTo(220, H);
  ctx.strokeStyle = divGrad;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Left panel: Avatar circle ─────────────────────────────────────────────
  const avX = 110;
  const avY = 130;
  const avR = 60;

  // Outer glow ring
  ctx.save();
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 24;
  ctx.beginPath();
  ctx.arc(avX, avY, avR + 4, 0, Math.PI * 2);
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth   = 2.5;
  ctx.stroke();
  ctx.restore();

  // Avatar bg gradient
  const avGrad = ctx.createRadialGradient(avX, avY - 20, 0, avX, avY, avR);
  avGrad.addColorStop(0, cfg.color + "44");
  avGrad.addColorStop(1, "#0a0f1e");
  ctx.beginPath();
  ctx.arc(avX, avY, avR, 0, Math.PI * 2);
  ctx.fillStyle = avGrad;
  ctx.fill();

  // Initials
  const initials = data.displayName.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
  ctx.save();
  ctx.fillStyle = cfg.color;
  ctx.font = `bold ${avR * 0.75}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 18;
  ctx.fillText(initials, avX, avY);
  ctx.restore();

  // Status dot
  const dotX = avX + avR * 0.7;
  const dotY = avY + avR * 0.7;
  ctx.save();
  (ctx as any).shadowColor = sc.color;
  (ctx as any).shadowBlur  = 12;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 11, 0, Math.PI * 2);
  ctx.fillStyle = sc.color;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 11, 0, Math.PI * 2);
  ctx.strokeStyle = "#080c18";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Status label below avatar
  ctx.fillStyle = sc.color;
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(sc.label, avX, avY + avR + 14);

  // ── Rank badge ────────────────────────────────────────────────────────────
  const rankGrad = ctx.createLinearGradient(20, avY - avR - 52, 200, avY - avR - 28);
  rankGrad.addColorStop(0, cfg.gradient[0]);
  rankGrad.addColorStop(1, cfg.gradient[1]);

  rr(ctx, 24, avY - avR - 56, 172, 28, 14);
  ctx.fillStyle = cfg.color + "20";
  ctx.fill();
  rr(ctx, 24, avY - avR - 56, 172, 28, 14);
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.save();
  ctx.fillStyle = cfg.color;
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 8;
  ctx.fillText(`★  ${cfg.label}`, 110, avY - avR - 42);
  ctx.restore();

  // Tagline below badge
  ctx.fillStyle = cfg.color + "99";
  ctx.font = "italic 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(cfg.tagline, 110, avY - avR - 22);

  // ── Member since (bottom of left panel) ──────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`Since ${data.memberSince}`, 110, H - 20);

  // ── Right panel: Name + Stats ──────────────────────────────────────────────
  const rx = 250;

  // Header bar
  const hGrad = ctx.createLinearGradient(rx, 30, W - 20, 30);
  hGrad.addColorStop(0, cfg.color + "22");
  hGrad.addColorStop(1, "transparent");
  rr(ctx, rx - 14, 26, W - rx - 6, 52, 10);
  ctx.fillStyle = hGrad;
  ctx.fill();

  // TDC tag
  ctx.save();
  ctx.fillStyle = cfg.color;
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 8;
  ctx.fillText("TOKYO DRIFT CUSTOMS", W - 26, 52);
  ctx.restore();

  // Name
  const nameFontSize = data.displayName.length > 16 ? 26 : 32;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  (ctx as any).shadowColor = cfg.color;
  (ctx as any).shadowBlur  = 12;
  ctx.fillText(data.displayName.slice(0, 22), rx, 52);
  ctx.restore();

  // ── Stats grid ─────────────────────────────────────────────────────────────
  const stats = [
    { icon: "💰", label: "COMMISSION", value: `${(data.commissionRate * 100).toFixed(0)}%` },
    { icon: "⏱️", label: "HRS / WEEK",  value: `${data.hoursThisWeek.toFixed(1)}h`         },
    { icon: "📋", label: "ORDERS / WK", value: `${data.ordersThisWeek}`                    },
    { icon: "💵", label: "TOTAL REV",   value: money(data.totalRevenue)                     },
  ];

  const colW = 190;
  const rowH = 80;
  const gsx  = rx - 10;
  const gsy  = 110;

  stats.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bx  = gsx + col * (colW + 10);
    const by  = gsy + row * rowH;

    // Card bg
    ctx.save();
    rr(ctx, bx, by, colW, rowH - 8, 10);
    ctx.fillStyle = cfg.color + "10";
    ctx.fill();
    ctx.strokeStyle = cfg.color + "33";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Left accent bar
    ctx.save();
    rr(ctx, bx, by, 3, rowH - 8, 2);
    const barGrad = ctx.createLinearGradient(bx, by, bx, by + rowH - 8);
    barGrad.addColorStop(0, cfg.gradient[0]);
    barGrad.addColorStop(1, cfg.gradient[1]);
    ctx.fillStyle = barGrad;
    ctx.fill();
    ctx.restore();

    // Value
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 22px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    (ctx as any).shadowColor = cfg.color;
    (ctx as any).shadowBlur  = 10;
    ctx.fillText(s.value, bx + 16, by + 10);
    ctx.restore();

    // Label
    ctx.fillStyle = cfg.color + "aa";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(s.label, bx + 16, by + 40);

    // Icon
    ctx.font = "16px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = cfg.color + "88";
    ctx.fillText(s.icon, bx + colW - 14, by + (rowH - 8) / 2);
  });

  // ── Bottom bar ─────────────────────────────────────────────────────────────
  const bbarY = H - 40;
  const bbGrad = ctx.createLinearGradient(220, bbarY, W, bbarY);
  bbGrad.addColorStop(0, cfg.color + "18");
  bbGrad.addColorStop(1, "transparent");
  ctx.fillStyle = bbGrad;
  ctx.fillRect(220, bbarY, W - 220, 40);

  // Thin top line
  const lineGrad = ctx.createLinearGradient(rx, bbarY, W, bbarY);
  lineGrad.addColorStop(0, cfg.color + "66");
  lineGrad.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.moveTo(rx - 14, bbarY);
  ctx.lineTo(W - 20, bbarY);
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`ID: ${data.discordId}`, rx, bbarY + 20);

  ctx.fillStyle = cfg.color + "66";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("東京ドリフトカスタム", W - 26, bbarY + 20);

  return canvas.toBuffer("image/png") as unknown as Buffer;
}
