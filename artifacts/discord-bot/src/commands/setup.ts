import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, TextChannel
} from "discord.js";
import { getGuildConfig } from "../db.js";
import { buildAdminPanelEmbed } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Tokyo Drift Customs — setup & configuration")
  .addSubcommand(s => s.setName("init").setDescription("Create the #tdc-admin control panel channel"))
  .addSubcommand(s => s.setName("status").setDescription("Show current bot configuration"));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild!;

  if (sub === "status") {
    const config = await getGuildConfig(guild.id);
    const embed = buildAdminPanelEmbed(config);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "init") {
    const config = await getGuildConfig(guild.id);

    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      });
    }
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
      permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    let adminChannel: TextChannel;
    try {
      adminChannel = await guild.channels.create({
        name: "tdc-admin",
        type: ChannelType.GuildText,
        topic: "⚙️ Tokyo Drift Customs — Admin control panel",
        permissionOverwrites: permOverwrites
      }) as TextChannel;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create admin channel: ${err.message}` });
      return;
    }

    await postAdminPanel(adminChannel, guild.id);
    await interaction.editReply({ content: `✅ Admin panel created in <#${adminChannel.id}>` });
  }
}

export async function postAdminPanel(channel: TextChannel, guildId: string) {
  const config = await getGuildConfig(guildId);
  const embed = buildAdminPanelEmbed(config);

  // Row 1 — channel setup
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("admin:setup:saleschannel").setLabel("➕ Sales Ch").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:setup:timeclock").setLabel("⏰ Timeclock").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:setup:orders").setLabel("📋 Orders").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:setup:jobs").setLabel("💼 Jobs").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:setup:logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary),
  );

  // Row 2 — more channels + roles
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("admin:setup:archive").setLabel("🗃️ Archive").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:setup:loach").setLabel("🌴 LOA Ch").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:setup:rafflech").setLabel("🎰 Raffle Ch").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:setup:roles").setLabel("🎭 Roles").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:setup:refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
  );

  // Row 3 — actions
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("admin:setup:jobpost").setLabel("📢 Post Job Ad").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin:setup:createraffle").setLabel("🎰 Create Raffle").setStyle(ButtonStyle.Success),
  );

  const msg = await channel.send({ embeds: [embed], components: [row1, row2, row3] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
