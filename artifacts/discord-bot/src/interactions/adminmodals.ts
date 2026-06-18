import {
  ModalSubmitInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits, TextChannel
} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildJobEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { postOrderPanel } from "./orderpanel.js";
import { postTimeclockPanel } from "./adminbuttons.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

const channelMap: Record<string, { field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id"; label: string }> = {
  orders:  { field: "orders_channel_id", label: "Orders"  },
  jobs:    { field: "jobs_channel_id",   label: "Jobs"    },
  logs:    { field: "log_channel_id",    label: "Logs"    },
  archive: { field: "archive_channel_id",label: "Archive" },
};

export async function handleAdminModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const [ns, section, action] = interaction.customId.split(":");
  if (ns !== "admin") return false;

  const guild = interaction.guild!;

  // ── Job Post ───────────────────────────────────────────────────────────────
  if (section === "jobpost") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const title = interaction.fields.getTextInputValue("title");
    const body = interaction.fields.getTextInputValue("body");
    const poster = await getProfile(interaction.user.id);
    const jobId = randomUUID();
    const embed = buildJobEmbed(title, body, poster?.display_name ?? interaction.user.username);
    const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`job:apply:${jobId}`).setLabel("📩  Apply Now").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`job:delete:${jobId}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger)
    );

    let msgId = "";
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.jobs_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.jobs_channel_id);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({ embeds: [embed], components: [applyRow] });
            msgId = msg.id;
          }
        } catch { /* ignore */ }
      }
    }

    await db.execute({
      sql: "INSERT INTO jobs (id, posted_by, title, body, discord_message_id) VALUES (?, ?, ?, ?, ?)",
      args: [jobId, interaction.user.id, title, body, msgId]
    });

    const jobsCh = interaction.guild ? (await getGuildConfig(interaction.guild.id))?.jobs_channel_id : null;
    await interaction.editReply({
      content: msgId
        ? `✅ Job **${title}** posted to <#${jobsCh}>!`
        : `✅ Job **${title}** saved — configure a jobs channel first to post it publicly.`
    });
    return true;
  }

  // ── Sales Channel: Create New ─────────────────────────────────────────────
  if (section === "saleschan" && action === "new") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const mechanicId = interaction.fields.getTextInputValue("mechanic_id").trim();
    const profile = await getProfile(mechanicId);
    if (!profile) {
      await interaction.editReply({ content: "❌ Mechanic not found. Make sure they're added via `/crew add` first." });
      return true;
    }

    const config = await getGuildConfig(guild.id);
    const channelName = `sales-${profile.display_name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;

    // Fetch the bot member and all required members/roles before building overwrites
    const botMember = guild.members.me;
    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];

    // Add bot permissions
    if (botMember) {
      permOverwrites.push({
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      });
    }

    // Add the mechanic by user ID
    permOverwrites.push({
      id: mechanicId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });

    // Add role-based overwrites (these are reliable — roles are always cached)
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
      permOverwrites.push({
        id: rid!,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });
    }

    // Also add individual owners from user_roles table, but fetch them first
    const managersR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
    for (const row of managersR.rows) {
      const mid = String(row[0]);
      if (!mid || mid === mechanicId) continue;
      try {
        // Fetch the member to ensure they're in cache before adding overwrite
        await guild.members.fetch(mid);
        permOverwrites.push({
          id: mid,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        });
      } catch { /* member not in server, skip */ }
    }

    let channel: TextChannel;
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `📍 Personal sales channel — ${profile.display_name}`,
        permissionOverwrites: permOverwrites
      }) as TextChannel;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}` });
      return true;
    }

    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, mechanicId] });
    await postOrderPanel(channel, mechanicId, profile.display_name, profile.commission_rate);

    await interaction.editReply({
      content: `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nThe order panel has been pinned.`
    });
    return true;
  }

  // ── Sales Channel: Attach Existing ────────────────────────────────────────
  if (section === "saleschan" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const mechanicId = interaction.fields.getTextInputValue("mechanic_id").trim();
    const channelId  = interaction.fields.getTextInputValue("channel_id").trim();

    const profile = await getProfile(mechanicId);
    if (!profile) {
      await interaction.editReply({ content: "❌ Mechanic not found. Use `/crew add` first." });
      return true;
    }

    let ch: any;
    try {
      ch = await guild.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
    } catch {
      await interaction.editReply({ content: "❌ Channel not found. Make sure the Channel ID is correct." });
      return true;
    }

    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channelId, mechanicId] });
    await postOrderPanel(ch as TextChannel, mechanicId, profile.display_name, profile.commission_rate);

    await interaction.editReply({
      content: `✅ Attached <#${channelId}> as **${profile.display_name}**'s sales channel and posted the order panel.`
    });
    return true;
  }

  // ── Timeclock: Attach Existing ─────────────────────────────────────────────
  if (section === "timeclock" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    try {
      const ch = await guild.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
    } catch {
      await interaction.editReply({ content: "❌ Channel not found." });
      return true;
    }

    await setGuildConfig(guild.id, "timeclock_channel_id", channelId);
    await interaction.editReply({ content: `✅ Timeclock channel set → <#${channelId}>` });
    return true;
  }

  // ── Generic channel: attach existing ──────────────────────────────────────
  if (section === "chan" && action === "setexisting") {
    const chanType = interaction.customId.split(":")[3];
    const cfg = channelMap[chanType];
    if (!cfg) return false;
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    try {
      const ch = await guild.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
    } catch {
      await interaction.editReply({ content: "❌ Channel not found." });
      return true;
    }

    await setGuildConfig(guild.id, cfg.field, channelId);
    await interaction.editReply({ content: `✅ **${cfg.label}** channel set → <#${channelId}>` });
    return true;
  }

  return false;
}
