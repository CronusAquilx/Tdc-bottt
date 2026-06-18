import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits
} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure Tokyo Drift Customs bot (owner only)")
  .addSubcommand(s =>
    s.setName("sales-channel")
      .setDescription("Create a personal sales channel for a mechanic")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("orders-channel")
      .setDescription("Set or create the #orders channel")
      .addChannelOption(o => o.setName("channel").setDescription("Existing channel (leave empty to create)"))
  )
  .addSubcommand(s =>
    s.setName("logs-channel")
      .setDescription("Set or create the #logs channel")
      .addChannelOption(o => o.setName("channel").setDescription("Existing channel (leave empty to create)"))
  )
  .addSubcommand(s =>
    s.setName("jobs-channel")
      .setDescription("Set or create the #jobs channel")
      .addChannelOption(o => o.setName("channel").setDescription("Existing channel (leave empty to create)"))
  )
  .addSubcommand(s =>
    s.setName("archive-channel")
      .setDescription("Set or create the #archive channel")
      .addChannelOption(o => o.setName("channel").setDescription("Existing channel (leave empty to create)"))
  )
  .addSubcommand(s => s.setName("status").setDescription("Show current bot configuration"));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild!;

  if (sub === "sales-channel") {
    const targetUser = interaction.options.getUser("mechanic", true);
    const profile = await getProfile(targetUser.id);
    if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found. Use `/crew add` first." }); return; }

    const channelName = `sales-${profile.display_name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;
    const managersR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: targetUser.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
    ];
    for (const row of managersR.rows) {
      permOverwrites.push({ id: String(row[0]), allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    if (guild.members.me) {
      permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] });
    }

    let channel: any;
    try {
      channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, topic: `Personal sales channel for ${profile.display_name}`, permissionOverwrites: permOverwrites });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}. Ensure the bot has **Manage Channels** permission.` });
      return;
    }

    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, targetUser.id] });

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🏁 Welcome, ${profile.display_name}!`)
      .setColor(COLORS.primary)
      .setDescription("This is your personal workspace. Orders, clock sessions, and daily summaries post here automatically.")
      .addFields(
        { name: "Commission Rate", value: `${(profile.commission_rate * 100).toFixed(0)}%`, inline: true },
        { name: "Status", value: profile.status.replace("_", " ").toUpperCase(), inline: true }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`clockin:mechanic:${targetUser.id}`).setLabel("🟢 Clock In").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`clockout:mechanic:${targetUser.id}`).setLabel("🔴 Clock Out").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`sales:viewdetailed:${targetUser.id}`).setLabel("📊 Analytics").setStyle(ButtonStyle.Primary)
    );
    await channel.send({ embeds: [welcomeEmbed], components: [row] });
    await interaction.editReply({ content: `✅ Sales channel created: <#${channel.id}>` });
    return;
  }

  const channelMap: Record<string, { field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id"; name: string; topic: string }> = {
    "orders-channel": { field: "orders_channel_id", name: "orders", topic: "Tokyo Drift Customs — Order submissions" },
    "logs-channel": { field: "log_channel_id", name: "tdc-logs", topic: "Tokyo Drift Customs — System logs" },
    "jobs-channel": { field: "jobs_channel_id", name: "jobs", topic: "Tokyo Drift Customs — Job postings" },
    "archive-channel": { field: "archive_channel_id", name: "archive", topic: "Tokyo Drift Customs — Archived orders" }
  };

  if (sub in channelMap) {
    const cfg = channelMap[sub];
    const existing = interaction.options.getChannel("channel");
    let channelId: string;
    if (existing) {
      channelId = existing.id;
    } else {
      try {
        const ch = await guild.channels.create({ name: cfg.name, type: ChannelType.GuildText, topic: cfg.topic }) as any;
        channelId = ch.id;
        const introEmbed = new EmbedBuilder()
          .setTitle(`🏁 Tokyo Drift Customs — ${cfg.name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`)
          .setColor(COLORS.primary).setDescription(cfg.topic).setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
        await ch.send({ embeds: [introEmbed] });
      } catch (err: any) { await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}` }); return; }
    }
    await setGuildConfig(guild.id, cfg.field, channelId);
    await interaction.editReply({ content: `✅ **${sub}** configured → <#${channelId}>` });
    return;
  }

  if (sub === "status") {
    const config = await getGuildConfig(guild.id);
    const embed = new EmbedBuilder()
      .setTitle("⚙️ Tokyo Drift Customs — Bot Configuration")
      .setColor(COLORS.dark)
      .addFields(
        { name: "Orders Channel", value: config?.orders_channel_id ? `<#${config.orders_channel_id}>` : "❌ Not set", inline: true },
        { name: "Jobs Channel", value: config?.jobs_channel_id ? `<#${config.jobs_channel_id}>` : "❌ Not set", inline: true },
        { name: "Logs Channel", value: config?.log_channel_id ? `<#${config.log_channel_id}>` : "❌ Not set", inline: true },
        { name: "Archive Channel", value: config?.archive_channel_id ? `<#${config.archive_channel_id}>` : "❌ Not set", inline: true }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }
}
