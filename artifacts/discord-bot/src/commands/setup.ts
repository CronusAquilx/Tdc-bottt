import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, TextChannel
} from "discord.js";
import { getGuildConfig } from "../db.js";
import { COLORS } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

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
    await interaction.editReply({ embeds: [buildStatusEmbed(config)] });
    return;
  }

  if (sub === "init") {
    const config = await getGuildConfig(guild.id);

    // Build safe permission overwrites — only include role IDs that are valid strings
    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      });
    }
    // Only add role overwrites for IDs that are actually configured & valid snowflakes
    const validId = (id: any) => typeof id === "string" && /^\d{17,20}$/.test(id);
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id]) {
      if (!validId(rid)) continue;
      // Verify the role actually exists in this guild before adding
      try {
        await guild.roles.fetch(rid!);
        permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      } catch { /* role not found — skip */ }
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

function buildStatusEmbed(config: any) {
  const ch = (id: string | null | undefined) => id ? `<#${id}>` : "`Not set`";
  const ro = (id: string | null | undefined) => id ? `<@&${id}>` : "`Not set`";
  return new EmbedBuilder()
    .setTitle("⚙️  TDC Configuration Status")
    .setColor(COLORS.dark)
    .addFields(
      { name: "📡 Channels", value:
          `📋 Orders: ${ch(config?.orders_channel_id)}\n` +
          `⏰ Timeclock: ${ch(config?.timeclock_channel_id)}\n` +
          `💼 Jobs: ${ch(config?.jobs_channel_id)}\n` +
          `📜 Logs: ${ch(config?.log_channel_id)}\n` +
          `🗃️ Archive: ${ch(config?.archive_channel_id)}\n` +
          `🌴 LOA: ${ch(config?.loa_channel_id)}\n` +
          `🎰 Raffle: ${ch(config?.raffle_channel_id)}\n` +
          `🏆 Leaderboard: ${ch(config?.leaderboard_channel_id)}`,
        inline: true
      },
      { name: "🎭 Roles", value:
          `👑 Owner: ${ro(config?.owner_role_id)}\n` +
          `🔧 Manager: ${ro(config?.manager_role_id)}\n` +
          `📚 Trainer: ${ro(config?.trainer_role_id)}\n` +
          `🔩 Mechanic: ${ro(config?.mechanic_role_id)}\n` +
          `🎓 Needs Training: ${ro((config as any)?.needs_training_role_id)}`,
        inline: true
      }
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export async function postAdminPanel(channel: TextChannel, guildId: string) {
  const config = await getGuildConfig(guildId);

  // ── Section: Header embed ──────────────────────────────────────────────────
  const headerEmbed = new EmbedBuilder()
    .setTitle("⚙️  TOKYO DRIFT CUSTOMS  ·  ADMIN PANEL")
    .setColor(COLORS.primary)
    .setDescription(
      "**Server control panel — use the section tabs below.**\n\n" +
      "Each button opens that section's settings and tools.\n" +
      "Only managers and above can interact with this panel."
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  // ── Section tabs (row 1) ──────────────────────────────────────────────────
  const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("admin:panel:staff").setLabel("👥  Staff").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:panel:channels").setLabel("📡  Channels").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:panel:raffle").setLabel("🎰  Raffle").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:panel:config").setLabel("⚙️  Config").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:panel:payroll").setLabel("💸  Payroll").setStyle(ButtonStyle.Success),
  );

  const msg = await channel.send({ embeds: [headerEmbed], components: [tabRow] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
