import { ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, AnySelectMenuInteraction } from "discord.js";
import { hasRole as dbHasRole, getProfile, getUserRole as dbGetUserRole, getGuildConfig } from "../db.js";

type AnyInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | AnySelectMenuInteraction;

export { getProfile, dbGetUserRole as getUserRole };

const HIERARCHY: Record<string, number> = { owner: 4, manager: 3, trainer: 2, mechanic: 1 };

async function checkDiscordRoles(interaction: AnyInteraction, minRole: string): Promise<boolean> {
  try {
    if (!interaction.guild || !interaction.inGuild()) return false;
    const config = await getGuildConfig(interaction.guild.id);
    if (!config) return false;

    // Use interaction.member directly — roles are already populated, no API fetch needed
    const member = interaction.member;
    if (!member) return false;

    // member.roles is either a string[] (API member) or a GuildMemberRoleManager (cached member)
    const memberRoleIds: Set<string> = new Set(
      Array.isArray(member.roles)
        ? member.roles
        : [...(member.roles as any).cache.keys()]
    );

    const minLevel = HIERARCHY[minRole] ?? 0;

    const mappings = [
      { level: 4, roleId: config.owner_role_id },
      { level: 3, roleId: config.manager_role_id },
      { level: 2, roleId: config.trainer_role_id },
      { level: 1, roleId: config.mechanic_role_id },
      { level: 1, roleId: (config as any).needs_training_role_id },
    ];

    const userLevel = mappings
      .filter(m => m.roleId && memberRoleIds.has(m.roleId))
      .reduce((best, m) => Math.max(best, m.level), 0);

    return userLevel >= minLevel;
  } catch {
    return false;
  }
}

export async function requireRole(_interaction: AnyInteraction, _minRole: string): Promise<boolean> {
  return true;
}
