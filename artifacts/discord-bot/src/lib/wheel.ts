import { createCanvas } from "@napi-rs/canvas";

const SIZE = 620;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = SIZE * 0.40;
const INNER_R = SIZE * 0.095;

const GOLD = "#f5c518";
const DARK_BG = "#060a12";

// Tokyo street vibe — deep saturated neons with dark variants for contrast
const SEG_PALETTES: [string, string][] = [
  ["#ff2d55", "#8b0020"],   // neon red / deep crimson
  ["#00d4ff", "#005f8b"],   // electric cyan / deep teal
  ["#ff6b00", "#7a2e00"],   // neon orange / dark ember
  ["#a855f7", "#4a0080"],   // neon purple / dark violet
  ["#00ff88", "#006640"],   // neon mint / dark jade
  ["#ff3aab", "#7a004d"],   // hot pink / dark magenta
  ["#ffd600", "#7a5800"],   // neon yellow / dark gold
  ["#00b4d8", "#004a60"],   // sky neon / deep blue
];

export function drawWheelBuffer(
  entryCount: number,
  rotationRad: number = 0,
  winnerIndices: number[] = [],
): Buffer {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  // ── Background with cityscape glow ────────────────────────────────────────
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Layered glow — purple/blue city haze behind wheel
  const bgGrad = ctx.createRadialGradient(CX, CY, 0, CX, CY, SIZE * 0.6);
  bgGrad.addColorStop(0, "rgba(80,20,120,0.45)");
  bgGrad.addColorStop(0.4, "rgba(10,30,80,0.4)");
  bgGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const n = entryCount;

  if (n === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No entries yet", CX, CY);
    return canvas.toBuffer("image/png") as unknown as Buffer;
  }

  const sliceAngle = (2 * Math.PI) / n;
  const hasWinners = winnerIndices.length > 0;

  // ── Outer halo glow ────────────────────────────────────────────────────────
  const halo = ctx.createRadialGradient(CX, CY, R - 10, CX, CY, R + 42);
  halo.addColorStop(0, "rgba(168,85,247,0.3)");
  halo.addColorStop(0.5, "rgba(0,212,255,0.12)");
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.arc(CX, CY, R + 42, 0, 2 * Math.PI);
  ctx.fillStyle = halo;
  ctx.fill();

  // ── Segments ───────────────────────────────────────────────────────────────
  for (let i = 0; i < n; i++) {
    const startAngle = rotationRad + i * sliceAngle - Math.PI / 2;
    const endAngle   = startAngle + sliceAngle;
    const midAngle   = startAngle + sliceAngle / 2;
    const isWinner   = winnerIndices.includes(i);
    const [bright, dark] = SEG_PALETTES[i % SEG_PALETTES.length];

    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();

    if (isWinner) {
      // Winner = gold gradient
      const wFill = ctx.createRadialGradient(
        CX + Math.cos(midAngle) * R * 0.5,
        CY + Math.sin(midAngle) * R * 0.5,
        0,
        CX, CY, R
      );
      wFill.addColorStop(0, "#ffe066");
      wFill.addColorStop(0.6, "#f5c518");
      wFill.addColorStop(1, "#b8860b");
      ctx.fillStyle = wFill;
      ctx.fill();
      // Shine overlay
      const shine = ctx.createRadialGradient(CX, CY, 0, CX, CY, R);
      shine.addColorStop(0, "rgba(255,255,255,0.22)");
      shine.addColorStop(0.45, "rgba(255,255,255,0.05)");
      shine.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = shine;
      ctx.fill();
    } else if (hasWinners) {
      // Non-winner = very dim
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.fill();
    } else {
      // Normal state — neon gradient from bright center to dark edge
      const seg = ctx.createLinearGradient(
        CX + Math.cos(midAngle) * INNER_R,
        CY + Math.sin(midAngle) * INNER_R,
        CX + Math.cos(midAngle) * R,
        CY + Math.sin(midAngle) * R
      );
      seg.addColorStop(0, bright);
      seg.addColorStop(1, dark);
      ctx.fillStyle = seg;
      ctx.fill();
      // Subtle luminance sheen
      const sheen = ctx.createRadialGradient(
        CX + Math.cos(midAngle) * R * 0.35,
        CY + Math.sin(midAngle) * R * 0.35,
        0,
        CX + Math.cos(midAngle) * R * 0.35,
        CY + Math.sin(midAngle) * R * 0.35,
        R * 0.5
      );
      sheen.addColorStop(0, "rgba(255,255,255,0.18)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sheen;
      ctx.fill();
    }

    // Separator line with neon colour
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();
    ctx.strokeStyle = isWinner ? "rgba(255,255,220,0.95)" : "rgba(0,0,0,0.45)";
    ctx.lineWidth   = isWinner ? 2.5 : 1.2;
    ctx.stroke();

    // Winner outer glow stroke
    if (isWinner) {
      ctx.save();
      (ctx as any).shadowColor = "#ffd700";
      (ctx as any).shadowBlur  = 28;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, startAngle, endAngle);
      ctx.closePath();
      ctx.strokeStyle = "rgba(255,215,0,0.75)";
      ctx.lineWidth   = 5;
      ctx.stroke();
      ctx.restore();
    }

    // Neon edge highlight on normal segments
    if (!hasWinners) {
      ctx.save();
      (ctx as any).shadowColor = bright + "88";
      (ctx as any).shadowBlur  = 8;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, startAngle, endAngle);
      ctx.closePath();
      ctx.strokeStyle = bright + "44";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // Labels
    if (n <= 30) {
      const labelR = R * (n <= 5 ? 0.56 : n <= 12 ? 0.63 : 0.68);
      const lx = CX + Math.cos(midAngle) * labelR;
      const ly = CY + Math.sin(midAngle) * labelR;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(midAngle + Math.PI / 2);
      const fs = Math.max(8, Math.min(16, Math.floor(260 / n)));
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (!hasWinners) {
        (ctx as any).shadowColor = bright;
        (ctx as any).shadowBlur  = 8;
      }
      ctx.fillStyle = isWinner ? "#1a0a00" : "#ffffff";
      ctx.fillText(`#${i + 1}`, 0, 0);
      ctx.restore();
    }
  }

  // ── Outer neon ring (alternating colour) ───────────────────────────────────
  // Glow behind ring
  ctx.save();
  (ctx as any).shadowColor = "#a855f7";
  (ctx as any).shadowBlur  = 18;
  ctx.beginPath();
  ctx.arc(CX, CY, R + 2, 0, 2 * Math.PI);
  ctx.strokeStyle = "#a855f7";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Bright gold outer line
  ctx.save();
  (ctx as any).shadowColor = GOLD;
  (ctx as any).shadowBlur  = 12;
  ctx.beginPath();
  ctx.arc(CX, CY, R + 6, 0, 2 * Math.PI);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  // Thin cyan outer accent
  ctx.beginPath();
  ctx.arc(CX, CY, R + 14, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(0,212,255,0.25)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── Center medallion ───────────────────────────────────────────────────────
  // Glow ring
  ctx.save();
  (ctx as any).shadowColor = "#00d4ff";
  (ctx as any).shadowBlur  = 22;
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R + 2, 0, 2 * Math.PI);
  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Dark fill
  const medallion = ctx.createRadialGradient(CX, CY, 0, CX, CY, INNER_R);
  medallion.addColorStop(0, "#1a0535");
  medallion.addColorStop(1, "#060a12");
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, 2 * Math.PI);
  ctx.fillStyle = medallion;
  ctx.fill();

  // Inner gold ring
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, 2 * Math.PI);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2;
  ctx.stroke();

  // TDC text
  const cf = Math.max(9, Math.floor(INNER_R * 0.52));
  ctx.save();
  (ctx as any).shadowColor = "#00d4ff";
  (ctx as any).shadowBlur  = 12;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${cf}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TDC", CX, CY);
  ctx.restore();

  // ── Pointer arrow ──────────────────────────────────────────────────────────
  const tipX  = CX + R + 1;
  const baseX = CX + R + 36;
  const halfH = 16;

  ctx.save();
  (ctx as any).shadowColor = "#ff2d55";
  (ctx as any).shadowBlur  = 20;
  ctx.beginPath();
  ctx.moveTo(tipX, CY);
  ctx.lineTo(baseX, CY - halfH);
  ctx.lineTo(baseX, CY + halfH);
  ctx.closePath();
  // Gradient fill: neon red to gold
  const pGrad = ctx.createLinearGradient(tipX, CY, baseX, CY);
  pGrad.addColorStop(0, "#ff2d55");
  pGrad.addColorStop(1, GOLD);
  ctx.fillStyle = pGrad;
  ctx.fill();
  (ctx as any).shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  return canvas.toBuffer("image/png") as unknown as Buffer;
}

/**
 * Returns the rotation that lands winner at the pointer (right/east).
 */
export function winnerRotation(winnerIdx: number, n: number): number {
  const sliceAngle   = (2 * Math.PI) / n;
  const winnerCenter = winnerIdx * sliceAngle + sliceAngle / 2;
  const base = Math.PI / 2 - winnerCenter;
  return ((base % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Returns 6 rotation values for the spin animation.
 * 5 intermediate frames spread around the wheel, then the final winner position.
 */
export function spinFrameRotations(finalNormalized: number): number[] {
  const mid = (finalNormalized + Math.PI) % (2 * Math.PI);
  const q1  = (finalNormalized + Math.PI * 0.4) % (2 * Math.PI);
  const q2  = (finalNormalized + Math.PI * 0.8) % (2 * Math.PI);
  const q3  = (finalNormalized + Math.PI * 1.2) % (2 * Math.PI);
  const q4  = (finalNormalized + Math.PI * 0.15) % (2 * Math.PI);
  return [q2, q3, mid, q1, q4, finalNormalized];
}
