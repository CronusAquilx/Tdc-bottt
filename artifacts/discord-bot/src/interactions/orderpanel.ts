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
  const roleEmoji = payPolicy.displayRole === "Head Manager" ? "👑"
    : payPolicy.displayRole === "Manager" ? "🧰"
    : payPolicy.displayRole === "Trainer" ? "🎓"
    : "🔧";
  const crewCut = payPolicy.crewCutRate > 0
    ? ` + **${(payPolicy.crewCutRate * 100).toFixed(0)}% crew cut**`
    : "";
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setColor(0xe5342b)
    .setDescription(
      `**Welcome, ${displayName}.**\n\n` +
      "This is your personal sales channel. Start a new order below.\n\n" +
      (updateEnabled
        ? `> ${roleEmoji} **${payPolicy.displayRole}**: **$${payPolicy.hourlyRate.toLocaleString("en-US")}/hr + ${(payPolicy.commissionRate * 100).toFixed(0)}% commission${crewCut}**\n\n`
        : `> 💵 Your commission rate: **${(commissionRate * 100).toFixed(0)}% of labour**\n\n`) +
      "> ⏰ **Clock in and out using the dedicated clock panel channel.**"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function buildPanelRow(mechanicId: string, updateEnabled: boolean, payLabel = "💸  Pay All My Orders"): ActionRowBuilder<ButtonBuilder> {
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
      .setLabel(payLabel)
      .setStyle(ButtonStyle.Primary),
  );
  return row;
}

/**
 * Buttons shown under every completed-order post in a sales channel:
 * New Order · My Own Car (when the update is live) · Pay.
 * Kept in one place so every completion path stays identical.
 */
export async function buildCompletedOrderRow(mechanicId: string): Promise<ActionRowBuilder<ButtonBuilder>> {
  return buildPanelRow(mechanicId, await isUpdateEnabled(), "💸  Pay");
}

async function buildPanel(
  channel: TextChannel,
  mechanicId: string,
  displayName: string,
  commissionRate: number,
) {
  const updateEnabled = await isUpdateEnabled();
  let roleLevel = await getUserRole(mechanicId) ?? "mechanic";
  if (updateEnabled && channel.guild) {
    const config = await getGuildConfig(channel.guild.id);
    const member = await channel.guild.members.fetch(mechanicId).catch(() => null);
    const memberRoles = member?.roles.cache;
    if (memberRoles) {
      if ([...splitRoleIds(config?.owner_role_id), ...splitRoleIds(config?.head_manager_role_id)].some(id => memberRoles.has(id))) roleLevel = "owner";
      else if (splitRoleIds(config?.manager_role_id).some(id => memberRoles.has(id))) roleLevel = "manager";
      else if (splitRoleIds(config?.trainer_role_id).some(id => memberRoles.has(id))) roleLevel = "trainer";
    }
  }
  return {
    embed: buildPanelEmbed(displayName, commissionRate, roleLevel, updateEnabled),
    row: buildPanelRow(mechanicId, updateEnabled),
  };
}

export async function postOrderPanel(
  channel: TextChannel,
  mechanicId: string,
  displayName: string,
  commissionRate: number
): Promise<{ message: any; pinned: boolean; updated: boolean }> {
  const { embed, row } = await buildPanel(channel, mechanicId, displayName, commissionRate);

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

function isSalesPanelMessage(m: any, botId: string | undefined): boolean {
  if (!botId || m.author?.id !== botId) return false;
  const embed = m.embeds?.[0];
  return embed?.title === PANEL_TITLE && String(embed.description ?? "").startsWith("**Welcome,");
}

/**
 * Always post a FRESH sales panel as the newest message in the channel, even
 * if one already exists. Any older copies of the bot's panel are deleted first
 * so there is never more than one, and the new one is pinned.
 */
export async function resendOrderPanel(
  channel: TextChannel,
  mechanicId: string,
  displayName: string,
  commissionRate: number
): Promise<{ message: any; pinned: boolean; removed: number }> {
  const { embed, row } = await buildPanel(channel, mechanicId, displayName, commissionRate);
  const botId = channel.client.user?.id;

  // Post the new panel first so the channel is never left without one.
  const msg = await channel.send({ embeds: [embed], components: [row] });
  let pinned = false;
  try {
    await msg.pin();
    pinned = true;
  } catch { /* no ManageMessages permission */ }

  // Then clear out the older panel copies (pinned and recent).
  let removed = 0;
  const old = new Map<string, any>();
  try {
    for (const m of (await channel.messages.fetchPinned()).values()) {
      if (m.id !== msg.id && isSalesPanelMessage(m, botId)) old.set(m.id, m);
    }
  } catch { /* ignore */ }
  try {
    for (const m of (await channel.messages.fetch({ limit: 50 })).values()) {
      if (m.id !== msg.id && isSalesPanelMessage(m, botId)) old.set(m.id, m);
    }
  } catch { /* ignore */ }
  for (const m of old.values()) {
    try { await m.delete(); removed++; } catch { /* already gone or no permission */ }
  }

  return { message: msg, pinned, removed };
}
