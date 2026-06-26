import {
  ChatInputCommandInteraction, ButtonInteraction,
  ModalSubmitInteraction, AnySelectMenuInteraction,
  PermissionFlagsBits
} from "discord.js";
import { hasRole as dbHasRole, getProfile, getUserRole as dbGetUserRole, getGuildConfig, splitRoleIds } from "../db.js";

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
      { level: 4, roleIds: splitRoleIds(config.owner_role_id) },
      { level: 3, roleIds: splitRoleIds(config.manager_role_id) },
      { level: 2, roleIds: splitRoleIds(config.trainer_role_id) },
      { level: 1, roleIds: splitRoleIds(config.mechanic_role_id) },
      { level: 1, roleIds: splitRoleIds((config as any).needs_training_role_id) },
    ];

    const userLevel = mappings
      .filter(m => m.roleIds.some(rid => memberRoleIds.has(rid)))
      .reduce((best, m) => Math.max(best, m.level), 0);

    return userLevel >= minLevel;
  } catch {
    return false;
  }
}

/**
 * Detect the highest role level for the user of this interaction.
 * Checks Discord roles (via guild config) first, then falls back to user_roles DB table.
 * Returns 'owner' | 'manager' | 'trainer' | 'mechanic'
 */
export async function detectUserRoleLevel(interaction: AnyInteraction): Promise<string> {
  try {
    if (interaction.guild && interaction.inGuild()) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config) {
        const member = interaction.member;
        if (member) {
          const memberRoleIds: Set<string> = new Set(
            Array.isArray(member.roles)
              ? member.roles
              : [...(member.roles as any).cache.keys()]
          );
          const mappings = [
            { level: 'owner',    roleIds: splitRoleIds(config.owner_role_id)   },
            { level: 'manager',  roleIds: splitRoleIds(config.manager_role_id) },
            { level: 'trainer',  roleIds: splitRoleIds(config.trainer_role_id) },
            { level: 'mechanic', roleIds: splitRoleIds(config.mechanic_role_id) },
          ];
          // Check all mappings and return the highest matching Discord role
          // Discord roles are always authoritative when they match
          for (const { level, roleIds } of mappings) {
            if (roleIds.some(rid => memberRoleIds.has(rid))) return level;
          }
          // No Discord role matched — fall through to DB fallback below
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: check user_roles DB table (used when Discord role config doesn't cover this user)
  const dbRole = await dbGetUserRole(interaction.user.id);
  return dbRole ?? 'mechanic';
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

  // Check Discord roles first — always authoritative when they match
  const discordAllowed = await checkDiscordRoles(interaction, minRole);
  if (discordAllowed) return true;

  // Fall back to user_roles DB table (covers users manually assigned via admin panel
  // or whose Discord role isn't mapped in guild config)
  const dbAllowed = await dbHasRole(interaction.user.id, minRole);
  if (dbAllowed) return true;

  try {
    if (!interaction.replied && !(interaction as any).deferred) {
      await (interaction as any).reply({ content: `❌ You don't have permission to do that. Required: **${minRole}** or above.`, ephemeral: true });
    } else if ((interaction as any).deferred) {
      await (interaction as any).followUp({ content: `❌ You don't have permission to do that. Required: **${minRole}** or above.`, ephemeral: true });
    }
  } catch { /* ignore */ }
  return false;
}
