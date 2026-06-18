import { createCanvas } from "@napi-rs/canvas";

const SIZE = 620;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = SIZE * 0.40;
const INNER_R = SIZE * 0.095;

const GOLD = "#f5c518";
const DARK_BG = "#0a0e1a";

const SEG_COLORS = [
  "#d93025",
  "#1a73e8",
  "#e07b00",
  "#188038",
  "#7b2ef1",
  "#c4180e",
  "#0097a7",
  "#c2185b",
];

export function drawWheelBuffer(
  entryCount: number,
  rotationRad: number = 0,
  winnerIndices: number[] = [],
): Buffer {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  // ── Dark background with radial vignette ──────────────────────────────────
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const bgGrad = ctx.createRadialGradient(CX, CY, 0, CX, CY, SIZE * 0.55);
  bgGrad.addColorStop(0, "rgba(26,38,80,0.65)");
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

  // ── Outer decorative glow ring ─────────────────────────────────────────────
  const outerGlow = ctx.createRadialGradient(CX, CY, R - 4, CX, CY, R + 24);
  outerGlow.addColorStop(0, "rgba(245,197,24,0.35)");
  outerGlow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.arc(CX, CY, R + 24, 0, 2 * Math.PI);
  ctx.fillStyle = outerGlow;
  ctx.fill();

  // ── Segments ───────────────────────────────────────────────────────────────
  for (let i = 0; i < n; i++) {
    const startAngle = rotationRad + i * sliceAngle - Math.PI / 2;
    const endAngle   = startAngle + sliceAngle;
    const midAngle   = startAngle + sliceAngle / 2;
    const isWinner   = winnerIndices.includes(i);
    const baseColor  = SEG_COLORS[i % SEG_COLORS.length];

    // Fill
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();

    if (isWinner) {
      ctx.fillStyle = GOLD;
      ctx.fill();
      // Bright inner highlight for winner
      const wg = ctx.createRadialGradient(CX, CY, INNER_R, CX, CY, R);
      wg.addColorStop(0, "rgba(255,255,255,0.25)");
      wg.addColorStop(0.5, "rgba(255,255,255,0.08)");
      wg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = wg;
      ctx.fill();
    } else if (hasWinners) {
      ctx.fillStyle = baseColor;
      ctx.fill();
      // Dim non-winners
      ctx.fillStyle = "rgba(0,0,0,0.58)";
      ctx.fill();
    } else {
      ctx.fillStyle = baseColor;
      ctx.fill();
      // Subtle highlight on all segments
      const sg = ctx.createRadialGradient(CX, CY, INNER_R, CX, CY, R);
      sg.addColorStop(0, "rgba(255,255,255,0.14)");
      sg.addColorStop(0.55, "rgba(255,255,255,0.03)");
      sg.addColorStop(1, "rgba(0,0,0,0.08)");
      ctx.fillStyle = sg;
      ctx.fill();
    }

    // Separator lines
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();
    ctx.strokeStyle = isWinner ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.2)";
    ctx.lineWidth   = isWinner ? 2.5 : 1.5;
    ctx.stroke();

    // Winner glow stroke
    if (isWinner) {
      ctx.save();
      (ctx as any).shadowColor = GOLD;
      (ctx as any).shadowBlur  = 22;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, startAngle, endAngle);
      ctx.closePath();
      ctx.strokeStyle = "rgba(245,197,24,0.7)";
      ctx.lineWidth   = 4;
      ctx.stroke();
      ctx.restore();
    }

    // Label
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
      (ctx as any).shadowColor = "rgba(0,0,0,0.9)";
      (ctx as any).shadowBlur  = 4;
      ctx.fillStyle = isWinner ? DARK_BG : "#ffffff";
      ctx.fillText(`#${i + 1}`, 0, 0);
      ctx.restore();
    }
  }

  // ── Gold outer ring ────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 5;
  ctx.stroke();

  // Thin accent ring
  ctx.beginPath();
  ctx.arc(CX, CY, R + 11, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── Center medallion ───────────────────────────────────────────────────────
  // Outer glow
  ctx.save();
  (ctx as any).shadowColor = GOLD;
  (ctx as any).shadowBlur  = 14;
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  // Dark fill
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, 2 * Math.PI);
  ctx.fillStyle = DARK_BG;
  ctx.fill();

  // Gold inner ring
  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, 2 * Math.PI);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.stroke();

  // TDC text
  const cf = Math.max(9, Math.floor(INNER_R * 0.52));
  ctx.save();
  (ctx as any).shadowColor = "rgba(245,197,24,0.8)";
  (ctx as any).shadowBlur  = 10;
  ctx.fillStyle = GOLD;
  ctx.font = `bold ${cf}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TDC", CX, CY);
  ctx.restore();

  // ── Pointer arrow (tip points LEFT into wheel) ─────────────────────────────
  const tipX  = CX + R + 1;
  const baseX = CX + R + 34;
  const halfH = 16;

  ctx.save();
  (ctx as any).shadowColor = GOLD;
  (ctx as any).shadowBlur  = 20;
  ctx.beginPath();
  ctx.moveTo(tipX, CY);
  ctx.lineTo(baseX, CY - halfH);
  ctx.lineTo(baseX, CY + halfH);
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();
  (ctx as any).shadowBlur = 0;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  return canvas.toBuffer("image/png") as unknown as Buffer;
}

/**
 * Returns the rotation that lands winner at the pointer (right/east).
 */
export function winnerRotation(winnerIdx: number, n: number): number {
  const sliceAngle  = (2 * Math.PI) / n;
  const winnerCenter = winnerIdx * sliceAngle + sliceAngle / 2;
  const base = Math.PI / 2 - winnerCenter;
  return ((base % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Returns 6 rotation values for the spin animation.
 * 5 intermediate frames that are visually distinct (spread across the wheel),
 * followed by the final winner position.
 */
export function spinFrameRotations(finalNormalized: number): number[] {
  // Fixed intermediate positions spread around the wheel (simulate deceleration visually)
  // Then snap to the winner position on the last frame
  const mid = (finalNormalized + Math.PI) % (2 * Math.PI); // opposite of winner
  const q1  = (finalNormalized + Math.PI * 0.4) % (2 * Math.PI);
  const q2  = (finalNormalized + Math.PI * 0.8) % (2 * Math.PI);
  const q3  = (finalNormalized + Math.PI * 1.2) % (2 * Math.PI);
  const q4  = (finalNormalized + Math.PI * 0.15) % (2 * Math.PI); // just before winner
  return [q2, q3, mid, q1, q4, finalNormalized];
}
