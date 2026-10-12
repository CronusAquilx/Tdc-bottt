import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel
} from "discord.js";
import { getGuildConfig, getUserRole, splitRoleIds } from "../db.js";
import { isUpdateEnabled } from "../lib/featureFlags.js";
import { payrollRateForRole } from "../lib/payrollPolicy.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";
const PANEL_TITLE = "🏁  TOKYO DRIFT CUSTOMS";

function buildPanelEmbed(displayName: string, commissionRate: number, roleLevel: string, updateEnabled: boolean): EmbedBuilder {
  const payPolicy = payrollRateForRole(roleLevel);
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setColor(0xe5342b)
    .setDescription(
      `**Welcome, ${displayName}.**\n\n` +
      "This is your personal sales channel. Start a new order below.\n\n" +
      (updateEnabled
        ? `> 💵 **${payPolicy.displayRole}**: **${(payPolicy.commissionRate * 100).toFixed(0)}% of labour** · **${payPolicy.hourlyRate.toLocaleString("en-US")} per active hour**\n\n`
        : `> 💵 Your commission rate: **${(commissionRate * 100).toFixed(0)}% of labour**\n\n`) +
      "> ⏰ **Clock in and out using the dedicated clock panel channel.**"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function buildPanelRow(mechanicId: string, updateEnabled: boolean): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("order:newpanel")
      .setLabel("📋  New Order")
      .setStyle(ButtonStyle.Success),
    ...(updateEnabled ? [
      new ButtonBuilder()
        .setCustomId("order:owncar")
        .setLabel("🚗  My Own Car")
        .setStyle(ButtonStyle.Secondary),
    ] : []),
    new ButtonBuilder()
      .setCustomId(`orderpay:start:${mechanicId}`)
      .setLabel("💸  Pay All My Orders")
      .setStyle(ButtonStyle.Primary),
  );
  return row;
}

export async function postOrderPanel(
  channel: TextChannel,
  mechanicId: string,
  displayName: string,
  commissionRate: number
): Promise<{ message: any; pinned: boolean; updated: boolean }> {
  const updateEnabled = await isUpdateEnabled();
  let roleLevel = await getUserRole(mechanicId) ?? "mechanic";
  if (updateEnabled && channel.guild) {
    const config = await getGuildConfig(channel.guild.id);
    const member = await channel.guild.members.fetch(mechanicId).catch(() => null);
    const memberRoles = member?.roles.cache;
    if (memberRoles) {
      if (splitRoleIds(config?.owner_role_id).some(id => memberRoles.has(id))) roleLevel = "owner";
      else if (splitRoleIds(config?.manager_role_id).some(id => memberRoles.has(id))) roleLevel = "manager";
      else if (splitRoleIds(config?.trainer_role_id).some(id => memberRoles.has(id))) roleLevel = "trainer";
    }
  }
  const embed = buildPanelEmbed(displayName, commissionRate, roleLevel, updateEnabled);
  const row = buildPanelRow(mechanicId, updateEnabled);

  // Try to find and edit an existing pinned panel from the bot so we update
  // the commission rate in place instead of posting a duplicate.
  try {
    const pins = await channel.messages.fetchPinned();
    const existing = pins.find(m =>
      m.author.id === channel.client.user?.id &&
      (m.embeds[0]?.title?.includes("TOKYO DRIFT CUSTOMS") ?? false)
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] });
      return { message: existing, pinned: true, updated: true };
    }
  } catch { /* ignore — channel may not allow pin fetch */ }

  // No existing panel found — post a new one and pin it.
  const msg = await channel.send({ embeds: [embed], components: [row] });
  let pinned = false;
  try {
    await msg.pin();
    pinned = true;
  } catch { /* no ManageMessages permission */ }
  return { message: msg, pinned, updated: false };
}
