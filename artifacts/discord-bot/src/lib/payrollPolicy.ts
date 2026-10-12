import { Guild } from "discord.js";
import { getGuildConfig, getUserRole, splitRoleIds } from "../db.js";

export type TdcRole = "mechanic" | "trainer" | "manager" | "owner";

export type PayrollRate = {
  hourlyRate: number;
  commissionRate: number;
  crewCutRate: number;
  displayRole: string;
};

const ROLE_RATES: Record<TdcRole, PayrollRate> = {
  mechanic: { hourlyRate: 15_000, commissionRate: 0.15, crewCutRate: 0, displayRole: "Mechanic" },
  trainer: { hourlyRate: 17_500, commissionRate: 0.20, crewCutRate: 0, displayRole: "Trainer" },
  manager: { hourlyRate: 20_000, commissionRate: 0.50, crewCutRate: 0.10, displayRole: "Manager" },
  owner: { hourlyRate: 25_000, commissionRate: 0.30, crewCutRate: 0.50, displayRole: "Head Manager" },
};

export function payrollRateForRole(role: string): PayrollRate {
  return ROLE_RATES[(role in ROLE_RATES ? role : "mechanic") as TdcRole];
}

export async function resolveTdcRole(guild: Guild | undefined, discordId: string): Promise<TdcRole> {
  if (guild) {
    const config = await getGuildConfig(guild.id);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member) {
      const roleIds = member.roles.cache;
      if (
        [...splitRoleIds(config?.owner_role_id), ...splitRoleIds(config?.head_manager_role_id)]
          .some(id => roleIds.has(id))
      ) return "owner";
      if (splitRoleIds(config?.manager_role_id).some(id => roleIds.has(id))) return "manager";
      if (splitRoleIds(config?.trainer_role_id).some(id => roleIds.has(id))) return "trainer";
    }
  }
  const assigned = await getUserRole(discordId);
  return assigned === "owner" || assigned === "manager" || assigned === "trainer" ? assigned : "mechanic";
}

export const WEEKLY_HOURS_GOAL = 5;
export const LOW_HOURS_STRIKE_THRESHOLD = WEEKLY_HOURS_GOAL;
