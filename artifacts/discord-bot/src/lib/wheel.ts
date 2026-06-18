import { createCanvas } from "@napi-rs/canvas";

const SEG_COLORS = [
  "#e5342b",
  "#3b82f6",
  "#ffd700",
  "#10b981",
  "#9b59b6",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
];

export function drawWheelBuffer(
  entryCount: number,
  rotationRad: number = 0,
  winnerIndices: number[] = [],
): Buffer {
  const SIZE = 560;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = SIZE * 0.42;
  const INNER_R = SIZE * 0.10;

  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, SIZE, SIZE);

  const n = entryCount;
  if (n === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No entries yet", CX, CY);
    return canvas.toBuffer("image/png") as unknown as Buffer;
  }

  const sliceAngle = (2 * Math.PI) / n;
  const hasWinners = winnerIndices.length > 0;

  for (let i = 0; i < n; i++) {
    const startAngle = rotationRad + i * sliceAngle - Math.PI / 2;
    const endAngle = startAngle + sliceAngle;
    const isWinner = winnerIndices.includes(i);
    const baseColor = SEG_COLORS[i % SEG_COLORS.length];

    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, R, startAngle, endAngle);
    ctx.closePath();

    if (isWinner) {
      ctx.fillStyle = "#ffd700";
      ctx.fill();
    } else if (hasWinners) {
      ctx.fillStyle = baseColor;
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();
    } else {
      ctx.fillStyle = baseColor;
      ctx.fill();
    }

    ctx.strokeStyle = isWinner ? "#ffffff" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = isWinner ? 3 : 1.5;
    ctx.stroke();

    if (n <= 32) {
      const midAngle = startAngle + sliceAngle / 2;
      const labelR = R * (n <= 6 ? 0.60 : 0.66);
      const lx = CX + Math.cos(midAngle) * labelR;
      const ly = CY + Math.sin(midAngle) * labelR;

      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(midAngle + Math.PI / 2);

      const fs = Math.max(8, Math.min(15, Math.floor(260 / n)));
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = isWinner ? "#1a1a2e" : "#ffffff";
      ctx.fillText(`#${i + 1}`, 0, 0);
      ctx.restore();
    }
  }

  ctx.beginPath();
  ctx.arc(CX, CY, R + 4, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(CX, CY, INNER_R, 0, 2 * Math.PI);
  ctx.fillStyle = "#111827";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const cf = Math.max(8, Math.floor(INNER_R * 0.52));
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${cf}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TDC", CX, CY);

  const px = CX + R + 6;
  const ps = 16;
  ctx.beginPath();
  ctx.moveTo(px + ps * 1.5, CY);
  ctx.lineTo(px + ps * 2.6, CY - ps * 0.65);
  ctx.lineTo(px + ps * 2.6, CY + ps * 0.65);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#ffd700";
  ctx.lineWidth = 2;
  ctx.stroke();

  return canvas.toBuffer("image/png") as unknown as Buffer;
}

export function winnerRotation(winnerIdx: number, n: number, extraSpins = 5): number {
  const sliceAngle = (2 * Math.PI) / n;
  const winnerCenter = winnerIdx * sliceAngle + sliceAngle / 2;
  const base = Math.PI / 2 - winnerCenter;
  const normalized = ((base % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return normalized + extraSpins * 2 * Math.PI;
}

export function spinFrameRotations(finalRotation: number, frameCount = 5): number[] {
  const steps = [0.12, 0.28, 0.48, 0.70, 0.88, 1.0];
  return steps.slice(0, frameCount + 1).map(t => (finalRotation * t) % (2 * Math.PI));
}
