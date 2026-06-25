import {
  ChatInputCommandInteraction, ButtonInteraction,
  ModalSubmitInteraction, AnySelectMenuInteraction,
  PermissionFlagsBits
} from "discord.js";
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

    const member = interaction.member;
    if (!member) return false;

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

export async function requireRole(interaction: AnyInteraction, minRole: string): Promise<boolean> {
  // Always allow Discord Administrators regardless of TDC role config
  if (interaction.guild && interaction.inGuild()) {
    try {
      const member = interaction.member;
      if (member && "permissions" in member) {
        const perms = member.permissions;
        if (typeof perms !== "string" && perms.has(PermissionFlagsBits.Administrator)) {
          return true;
        }
      }
    } catch { /* ignore */ }
  }

  // If no guild or DM, deny
  if (!interaction.guild) {
    try {
      if (!interaction.replied && !(interaction as any).deferred) {
        await (interaction as any).reply({ content: "❌ This can only be used in a server.", ephemeral: true });
      }
    } catch { /* ignore */ }
    return false;
  }

  // Check if any roles are configured — if none are set, allow through gracefully
  const config = await getGuildConfig(interaction.guild.id);
  const hasAnyRoleConfig = !!(
    config?.owner_role_id || config?.manager_role_id ||
    config?.trainer_role_id || config?.mechanic_role_id ||
    (config as any)?.needs_training_role_id
  );
  if (!hasAnyRoleConfig) return true;

  const allowed = await checkDiscordRoles(interaction, minRole);
  if (!allowed) {
    try {
      if (!interaction.replied && !(interaction as any).deferred) {
        await (interaction as any).reply({ content: `❌ You don't have permission to do that. Required: **${minRole}** or above.`, ephemeral: true });
      } else if ((interaction as any).deferred) {
        await (interaction as any).followUp({ content: `❌ You don't have permission to do that. Required: **${minRole}** or above.`, ephemeral: true });
      }
    } catch { /* ignore */ }
  }
  return allowed;
}
