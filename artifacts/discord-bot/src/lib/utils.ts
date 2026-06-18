import { randomUUID } from "crypto";

export { randomUUID };

export function weekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

export function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function paginate<T>(arr: T[], page: number, size = 10): { items: T[]; total: number; pages: number } {
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.max(0, Math.min(page, pages - 1));
  return { items: arr.slice(p * size, p * size + size), total, pages };
}
