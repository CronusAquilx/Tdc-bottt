import {
  ChannelType,
  Guild,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { db, getGuildConfig, getProfile, splitRoleIds } from "../db.js";
import { postOrderPanel } from "../interactions/orderpanel.js";

export interface SalesChannelSetupResult {
  channel: TextChannel;
  created: boolean;
  panelPosted: boolean;
  panelPinned: boolean;
}

function channelSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/**
 * Create or reuse a mechanic's private top-level sales channel and post its
 * order panel. Existing valid channel links and same-name channels are reused
 * so bulk onboarding cannot create duplicates.
 */
export async function ensureMechanicSalesChannel(
  guild: Guild,
  mechanicId: string,
  categoryId?: string,
): Promise<SalesChannelSetupResult> {
  const profile = await getProfile(mechanicId);
  if (!profile) throw new Error("Mechanic profile was not found");

  let channel: TextChannel | null = null;
  let created = false;

  if (profile.sales_channel_id) {
    const linked = await guild.channels.fetch(profile.sales_channel_id).catch(() => null);
    if (linked?.type === ChannelType.GuildText) channel = linked as TextChannel;
  }

  const channelName = `sales-${channelSlug(profile.display_name)}`;
  if (!channel) {
    const channels = await guild.channels.fetch();
    const existing = [...channels.values()].find(candidate =>
      candidate?.type === ChannelType.GuildText && candidate.name === channelName
    );
    if (existing) channel = existing as TextChannel;
  }

  if (!channel) {
    const config = await getGuildConfig(guild.id);
    const permissionOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];

    if (guild.members.me) {
      permissionOverwrites.push({
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    permissionOverwrites.push({
      id: mechanicId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });

    for (const roleId of [
      ...splitRoleIds(config?.owner_role_id),
      ...splitRoleIds(config?.manager_role_id),
      ...splitRoleIds(config?.trainer_role_id),
    ]) {
      permissionOverwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    try {
      const staffRows = await db.execute(
        "SELECT discord_id FROM user_roles WHERE role IN ('owner','manager','trainer')"
      );
      for (const row of staffRows.rows) {
        const staffId = String(row[0] ?? "");
        if (!staffId || staffId === mechanicId) continue;
        try {
          await guild.members.fetch(staffId);
          permissionOverwrites.push({
            id: staffId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          });
        } catch {
          // Staff member is not currently in this guild.
        }
      }
    } catch {
      // The configured staff roles above still protect the channel.
    }

    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      ...(categoryId ? { parent: categoryId } : {}),
      topic: `📍 Personal sales channel — ${profile.display_name}`,
      permissionOverwrites,
    }) as TextChannel;
    created = true;
  }

  if (profile.sales_channel_id !== channel.id) {
    await db.execute({
      sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?",
      args: [channel.id, mechanicId],
    });
  }

  let panelPosted = false;
  let panelPinned = false;
  try {
    const panel = await postOrderPanel(
      channel,
      mechanicId,
      profile.display_name,
      profile.commission_rate,
    );
    panelPosted = true;
    panelPinned = panel.pinned;
  } catch {
    // The caller reports the channel separately from a panel permission issue.
  }

  return { channel, created, panelPosted, panelPinned };
}