export interface WarnInfo {
  warnedAt: number;
  msgId?: string;
  chanId?: string;
  mechanicId: string;
}

export const warnedMechanics = new Map<string, WarnInfo>(); // key = timeclock id
export const stayedIn = new Map<string, number>();           // key = mechanic_id → timestamp of last "stay in"
