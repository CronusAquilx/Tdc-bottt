import { ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, AnySelectMenuInteraction } from "discord.js";
import { hasRole as dbHasRole, getProfile, getUserRole as dbGetUserRole } from "../db.js";

type AnyInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | AnySelectMenuInteraction;

export { getProfile, dbGetUserRole as getUserRole };

export async function requireRole(interaction: AnyInteraction, minRole: string): Promise<boolean> {
  const ok = await dbHasRole(interaction.user.id, minRole);
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
