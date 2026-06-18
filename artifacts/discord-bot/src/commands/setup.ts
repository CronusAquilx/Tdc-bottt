import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  RoleSelectMenuBuilder
} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig } from "../db.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure Tokyo Drift Customs bot")
  .addSubcommand(s =>
    s.setName("sales-channel")
      .setDescription("Create a personal sales channel for a mechanic")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("order-panel")
      .setDescription("Post the pinned 'Create New Order' panel in sales channel(s)")
      .addUserOption(o => o.setName("mechanic").setDescription("Specific mechanic (leave empty for all)"))
  )
  .addSubcommand(s =>
    s.setName("timeclock-channel")
      .setDescription("Create the shared timeclock channel with Clock In / Clock Out buttons")
      .addChannelOption(o => o.setName("channel").setDescription("Existing channel (leave empty to create new)"))
  )
  .addSubcommand(s =>
    s.setName("orders-channel")
      .setDescription("Set or create the fallback #orders channel")
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
  .addSubcommand(s => s.setName("roles").setDescription("Map Discord server roles to bot permission levels"))
  .addSubcommand(s => s.setName("status").setDescription("Show current bot configuration"));

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild!;

  // ── roles ─────────────────────────────────────────────────────────────────
  if (sub === "roles") {
    const config = await getGuildConfig(guild.id);
    const embed = new EmbedBuilder()
      .setTitle("⚙️  Role Configuration")
      .setColor(COLORS.primary)
      .setDescription(
        "Use the dropdowns below to link your Discord server roles to bot permission levels.\n\n" +
        `**👑 Owner** → ${config?.owner_role_id ? `<@&${config.owner_role_id}>` : "_Not set_"}\n` +
        `**🔧 Manager** → ${config?.manager_role_id ? `<@&${config.manager_role_id}>` : "_Not set_"}\n` +
        `**📚 Trainer** → ${config?.trainer_role_id ? `<@&${config.trainer_role_id}>` : "_Not set_"}\n` +
        `**🔩 Mechanic** → ${config?.mechanic_role_id ? `<@&${config.mechanic_role_id}>` : "_Not set_"}`
      )
      .setFooter({ text: FOOTER });

    const rows = [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:owner").setPlaceholder("👑 Select Owner role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:manager").setPlaceholder("🔧 Select Manager role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:trainer").setPlaceholder("📚 Select Trainer role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:mechanic").setPlaceholder("🔩 Select Mechanic role")),
    ];

    await interaction.editReply({ embeds: [embed], components: rows });
    return;
  }

  // ── sales-channel ─────────────────────────────────────────────────────────
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
      const mid = String(row[0]);
      if (mid) permOverwrites.push({ id: mid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    const config = await getGuildConfig(guild.id);
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
      permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    if (guild.members.me) {
      permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
    }

    let channel: any;
    try {
      channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, topic: `📍 Personal sales channel — ${profile.display_name}`, permissionOverwrites: permOverwrites });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}` });
      return;
    }

    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, targetUser.id] });

    // Post order panel
    await postOrderPanel(channel, targetUser.id, profile.display_name, profile.commission_rate);

    await interaction.editReply({ content: `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nThe **Create New Order** panel has been pinned.` });
    return;
  }

  // ── order-panel ───────────────────────────────────────────────────────────
  if (sub === "order-panel") {
    const targetUser = interaction.options.getUser("mechanic");
    let mechanics: { discord_id: string; display_name: string; sales_channel_id: string | null; commission_rate: number }[] = [];

    if (targetUser) {
      const p = await getProfile(targetUser.id);
      if (!p) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }
      mechanics = [p];
    } else {
      const r = await db.execute("SELECT discord_id, display_name, sales_channel_id, commission_rate FROM profiles WHERE sales_channel_id IS NOT NULL");
      mechanics = r.rows.map(row => ({
        discord_id: String(row[0] ?? ""),
        display_name: String(row[1] ?? ""),
        sales_channel_id: row[2] ? String(row[2]) : null,
        commission_rate: Number(row[3] ?? 0.3)
      }));
    }

    if (!mechanics.length) {
      await interaction.editReply({ content: "❌ No mechanics with sales channels found. Use `/setup sales-channel` first." });
      return;
    }

    let posted = 0;
    for (const mech of mechanics) {
      if (!mech.sales_channel_id) continue;
      try {
        const ch = await guild.channels.fetch(mech.sales_channel_id);
        if (ch?.isTextBased()) {
          await postOrderPanel(ch as any, mech.discord_id, mech.display_name, mech.commission_rate);
          posted++;
        }
      } catch { /* channel may have been deleted */ }
    }

    await interaction.editReply({ content: `✅ Order panel posted and pinned in **${posted}** sales channel${posted !== 1 ? "s" : ""}.` });
    return;
  }

  // ── timeclock-channel ─────────────────────────────────────────────────────
  if (sub === "timeclock-channel") {
    const existing = interaction.options.getChannel("channel");
    let channelId: string;

    if (existing) {
      channelId = existing.id;
    } else {
      try {
        const ch = await guild.channels.create({
          name: "tdc-timeclock",
          type: ChannelType.GuildText,
          topic: "⏰ Tokyo Drift Customs — Clock in and out here",
          permissionOverwrites: [
            { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
            ...(guild.members.me ? [{ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] }] : [])
          ]
        }) as any;
        channelId = ch.id;

        // Post the timeclock panel
        const panelEmbed = new EmbedBuilder()
          .setTitle("⏰  TIME CLOCK")
          .setColor(COLORS.dark)
          .setDescription(
            "Track your shifts below.\n\n" +
            "Click **Clock In** when your shift starts — the bot will post your session with a **live timer** that updates in real-time.\n" +
            "Click **Clock Out** when you're done to log your total session time.\n\n" +
            "_Only mechanics can use these buttons._"
          )
          .setFooter({ text: FOOTER })
          .setTimestamp();

        const clockRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("clockin:panel").setLabel("🟢 Clock In").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("clockout:panel").setLabel("🔴 Clock Out").setStyle(ButtonStyle.Danger)
        );

        const panelMsg = await ch.send({ embeds: [panelEmbed], components: [clockRow] });
        try { await panelMsg.pin(); } catch { /* ignore pin errors */ }
      } catch (err: any) {
        await interaction.editReply({ content: `❌ Failed to create timeclock channel: ${err.message}` });
        return;
      }
    }

    await setGuildConfig(guild.id, "timeclock_channel_id", channelId);
    await interaction.editReply({ content: `✅ Timeclock channel set → <#${channelId}>` });
    return;
  }

  // ── standard channel configs ───────────────────────────────────────────────
  const channelMap: Record<string, { field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id"; name: string; topic: string }> = {
    "orders-channel": { field: "orders_channel_id", name: "orders", topic: "Tokyo Drift Customs — Order submissions" },
    "logs-channel": { field: "log_channel_id", name: "tdc-logs", topic: "Tokyo Drift Customs — System logs" },
    "jobs-channel": { field: "jobs_channel_id", name: "tdc-jobs", topic: "Tokyo Drift Customs — Job postings" },
    "archive-channel": { field: "archive_channel_id", name: "tdc-archive", topic: "Tokyo Drift Customs — Archived orders" }
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
      } catch (err: any) { await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}` }); return; }
    }
    await setGuildConfig(guild.id, cfg.field, channelId);
    await interaction.editReply({ content: `✅ **${sub}** configured → <#${channelId}>` });
    return;
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (sub === "status") {
    const config = await getGuildConfig(guild.id);
    const embed = new EmbedBuilder()
      .setTitle("⚙️  Bot Configuration")
      .setColor(COLORS.dark)
      .addFields(
        { name: "Orders Channel", value: config?.orders_channel_id ? `<#${config.orders_channel_id}>` : "❌ Not set", inline: true },
        { name: "Jobs Channel", value: config?.jobs_channel_id ? `<#${config.jobs_channel_id}>` : "❌ Not set", inline: true },
        { name: "Logs Channel", value: config?.log_channel_id ? `<#${config.log_channel_id}>` : "❌ Not set", inline: true },
        { name: "Archive Channel", value: config?.archive_channel_id ? `<#${config.archive_channel_id}>` : "❌ Not set", inline: true },
        { name: "Timeclock Channel", value: config?.timeclock_channel_id ? `<#${config.timeclock_channel_id}>` : "❌ Not set", inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        { name: "Owner Role", value: config?.owner_role_id ? `<@&${config.owner_role_id}>` : "❌ Not set", inline: true },
        { name: "Manager Role", value: config?.manager_role_id ? `<@&${config.manager_role_id}>` : "❌ Not set", inline: true },
        { name: "Trainer Role", value: config?.trainer_role_id ? `<@&${config.trainer_role_id}>` : "❌ Not set", inline: true },
        { name: "Mechanic Role", value: config?.mechanic_role_id ? `<@&${config.mechanic_role_id}>` : "❌ Not set", inline: true }
      )
      .setFooter({ text: FOOTER }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }
}

async function postOrderPanel(channel: any, mechanicId: string, displayName: string, commissionRate: number) {
  const panelEmbed = new EmbedBuilder()
    .setTitle("🏁  TOKYO DRIFT CUSTOMS")
    .setColor(0xe5342b)
    .setDescription(
      "**Built Different. Driven Hard.**\n\n" +
      `Welcome to your sales channel, **${displayName}**.\n` +
      "Click below to create a new order — services, parts, and your commission are automatically calculated.\n\n" +
      `> 💵 Your commission rate: **${(commissionRate * 100).toFixed(0)}%** of labour`
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("order:newpanel")
      .setLabel("📋  Create New Order")
      .setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [panelEmbed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
}
