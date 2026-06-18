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

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return false;

    const memberRoleIds = new Set(member.roles.cache.keys());
    const minLevel = HIERARCHY[minRole] ?? 0;

    const mappings = [
      { level: 4, roleId: config.owner_role_id },
      { level: 3, roleId: config.manager_role_id },
      { level: 2, roleId: config.trainer_role_id },
      { level: 1, roleId: config.mechanic_role_id },
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
  let ok = await dbHasRole(interaction.user.id, minRole);

  // Fallback: check Discord server roles mapped in guild config
  if (!ok) {
    ok = await checkDiscordRoles(interaction, minRole);
  }

  if (!ok) {
    const msg = {
      content: `❌ **Access Denied** — This command requires the **${minRole}** role or higher.`,
      ephemeral: true as const
    };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await (interaction as any).reply(msg);
      }
    } catch { /* ignore */ }
    return false;
  }
  return true;
}
