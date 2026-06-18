import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
  RoleSelectMenuBuilder,
  TextChannel
} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildAdminPanelEmbed, buildJobEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { postOrderPanel } from "./orderpanel.js";
import { showCreateRaffleModal } from "./raffle.js";
import { showLoaModal } from "./loa.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

// ─────────────────────────────────────────────────────────────────────────────
// Modal-showing actions MUST be at the top — showModal() must be the very
// first Discord API response (no defer/reply allowed before it).
// ─────────────────────────────────────────────────────────────────────────────
export async function handleAdminButton(interaction: ButtonInteraction): Promise<boolean> {
  const parts = interaction.customId.split(":");
  const [ns, section, action] = parts;
  if (ns !== "admin") return false;

  const guild = interaction.guild!;

  // ── MODAL-FIRST HANDLERS (single role check, immediately show modal) ────────
  if (section === "setup" && action === "createraffle") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await showCreateRaffleModal(interaction);
    return true;
  }

  if (section === "setup" && action === "jobpost") {
    if (!(await requireRole(interaction, "owner"))) return true;
    const modal = new ModalBuilder().setCustomId("admin:jobpost").setTitle("Post a Job Ad");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Position Title").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. Performance Builder, Detailer...")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("body").setLabel("Job Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setPlaceholder("Describe the role, requirements, pay, etc...")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (section === "setup" && action === "loa") {
    await showLoaModal(interaction);
    return true;
  }

  if (section === "saleschan" && action === "new") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const modal = new ModalBuilder().setCustomId("admin:saleschan:new").setTitle("Create Sales Channel");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("mechanic_id").setLabel("Mechanic's Discord User ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Right-click user → Copy ID")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (section === "saleschan" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const modal = new ModalBuilder().setCustomId("admin:saleschan:existing").setTitle("Attach Existing Sales Channel");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("mechanic_id").setLabel("Mechanic's Discord User ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Right-click user → Copy ID")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("channel_id").setLabel("Channel ID to attach").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Right-click channel → Copy ID")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (section === "timeclock" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const modal = new ModalBuilder().setCustomId("admin:timeclock:existing").setTitle("Attach Existing Timeclock Channel");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("channel_id").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Right-click channel → Copy ID")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (section === "chan" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const chanType = parts[3];
    const cfg = CHANNEL_MAP[chanType];
    if (!cfg) return false;
    const modal = new ModalBuilder().setCustomId(`admin:chan:setexisting:${chanType}`).setTitle(`Attach ${cfg.label} Channel`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("channel_id").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Right-click channel → Copy ID")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // ── ALL OTHER HANDLERS (can defer/reply freely) ────────────────────────────
  if (!(await requireRole(interaction, "trainer"))) return true;

  // ── Refresh admin panel ────────────────────────────────────────────────────
  if (section === "setup" && action === "refresh") {
    await interaction.deferUpdate();
    const config = await getGuildConfig(guild.id);
    const embed = buildAdminPanelEmbed(config);
    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  // ── Set Roles ──────────────────────────────────────────────────────────────
  if (section === "setup" && action === "roles") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const config = await getGuildConfig(guild.id);
    const embed = new EmbedBuilder()
      .setTitle("🎭  Role Configuration")
      .setColor(COLORS.dark)
      .setDescription(
        "Map your Discord roles to bot permission levels.\n\n" +
        `👑 Owner → ${config?.owner_role_id ? `<@&${config.owner_role_id}>` : "_Not set_"}\n` +
        `🔧 Manager → ${config?.manager_role_id ? `<@&${config.manager_role_id}>` : "_Not set_"}\n` +
        `📚 Trainer → ${config?.trainer_role_id ? `<@&${config.trainer_role_id}>` : "_Not set_"}\n` +
        `🔩 Mechanic → ${config?.mechanic_role_id ? `<@&${config.mechanic_role_id}>` : "_Not set_"}`
      )
      .setFooter({ text: FOOTER });
    const rows = [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:owner").setPlaceholder("👑 Select Owner role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:manager").setPlaceholder("🔧 Select Manager role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:trainer").setPlaceholder("📚 Select Trainer role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:mechanic").setPlaceholder("🔩 Select Mechanic role")),
    ];
    await interaction.editReply({ embeds: [embed], components: rows });
    return true;
  }

  // ── Sales Channel setup ────────────────────────────────────────────────────
  if (section === "setup" && action === "saleschannel") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("➕  Sales Channel Setup")
      .setColor(COLORS.primary)
      .setDescription(
        "**How would you like to set up a sales channel?**\n\n" +
        "🆕 **Create New** — bot creates a fresh private channel for the mechanic\n" +
        "🔗 **Use Existing** — attach an existing channel as their sales channel"
      )
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:saleschan:new").setLabel("🆕 Create New Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:saleschan:existing").setLabel("🔗 Use Existing Channel").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  // ── Timeclock channel ──────────────────────────────────────────────────────
  if (section === "setup" && action === "timeclock") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("⏰  Timeclock Channel Setup")
      .setColor(COLORS.dark)
      .setDescription("Create a new timeclock channel or attach an existing one.")
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:timeclock:new").setLabel("🆕 Create New").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:timeclock:existing").setLabel("🔗 Use Existing").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  if (section === "timeclock" && action === "new") {
    await interaction.deferUpdate();
    try {
      const config = await getGuildConfig(guild.id);
      const permOverwrites: any[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ];
      if (guild.members.me) {
        permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
      }
      for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id, config?.mechanic_role_id].filter(Boolean)) {
        permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] });
      }
      const ch = await guild.channels.create({
        name: "tdc-timeclock",
        type: ChannelType.GuildText,
        topic: "⏰ Tokyo Drift Customs — Clock in and out here",
        permissionOverwrites: permOverwrites
      }) as TextChannel;
      await postTimeclockPanel(ch);
      await setGuildConfig(guild.id, "timeclock_channel_id", ch.id);
      await interaction.followUp({ content: `✅ Timeclock channel created → <#${ch.id}>`, ephemeral: true });
    } catch (err: any) {
      await interaction.followUp({ content: `❌ Failed: ${err.message}`, ephemeral: true });
    }
    return true;
  }

  // ── Generic channel setups (Orders, Jobs, Logs, Archive, LOA, Raffle) ──────
  if (section === "setup" && action in CHANNEL_MAP) {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const cfg = CHANNEL_MAP[action];
    const embed = new EmbedBuilder()
      .setTitle(`📡  ${cfg.label} Channel Setup`)
      .setColor(COLORS.dark)
      .setDescription(`Create a new **#${cfg.name}** channel, or attach an existing one.`)
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`admin:chan:new:${action}`).setLabel("🆕 Create New").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`admin:chan:existing:${action}`).setLabel("🔗 Use Existing").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  if (section === "chan" && action === "new") {
    const chanType = parts[3];
    const cfg = CHANNEL_MAP[chanType];
    if (!cfg) return false;
    await interaction.deferUpdate();
    try {
      const ch = await guild.channels.create({ name: cfg.name, type: ChannelType.GuildText, topic: cfg.topic }) as TextChannel;
      await setGuildConfig(guild.id, cfg.field, ch.id);
      await postChannelPanel(ch, chanType);
      await interaction.followUp({ content: `✅ **#${cfg.name}** created → <#${ch.id}>`, ephemeral: true });
    } catch (err: any) {
      await interaction.followUp({ content: `❌ Failed: ${err.message}`, ephemeral: true });
    }
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel map (used for generic setup + modal attach flows)
// ─────────────────────────────────────────────────────────────────────────────
export const CHANNEL_MAP: Record<string, {
  field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id" | "loa_channel_id" | "raffle_channel_id";
  name: string; topic: string; label: string;
}> = {
  orders:   { field: "orders_channel_id",  name: "tdc-orders",  topic: "Tokyo Drift Customs — Order submissions",  label: "Orders"  },
  jobs:     { field: "jobs_channel_id",     name: "tdc-jobs",    topic: "Tokyo Drift Customs — Job postings",       label: "Jobs"    },
  logs:     { field: "log_channel_id",      name: "tdc-logs",    topic: "Tokyo Drift Customs — System logs",        label: "Logs"    },
  archive:  { field: "archive_channel_id",  name: "tdc-archive", topic: "Tokyo Drift Customs — Archived orders",    label: "Archive" },
  loach:    { field: "loa_channel_id",      name: "tdc-loa",     topic: "Tokyo Drift Customs — Leave of Absence",   label: "LOA"     },
  rafflech: { field: "raffle_channel_id",   name: "tdc-raffle",  topic: "Tokyo Drift Customs — Raffles",            label: "Raffle"  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Panel embeds posted when channels are created or attached
// ─────────────────────────────────────────────────────────────────────────────
async function postChannelPanel(channel: TextChannel, chanType: string) {
  if (chanType === "loach") {
    await postLoaPanel(channel);
  } else if (chanType === "rafflech") {
    await postRafflePanel(channel);
  }
  // orders, jobs, logs, archive — no panel needed
}

export async function postLoaPanel(channel: TextChannel) {
  const embed = new EmbedBuilder()
    .setTitle("🌴  LEAVE OF ABSENCE")
    .setColor(0xf39c12)
    .setDescription(
      "**Tokyo Drift Customs — LOA Board**\n\n" +
      "Staff members can submit a Leave of Absence request to let management know you'll be away.\n\n" +
      "**How to submit:**\n" +
      "• Use the `/loa` command anywhere in the server\n" +
      "• Requests will appear here for management to review\n\n" +
      "*Management can approve or deny requests using the buttons below each submission.*"
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("admin:setup:loa")
      .setLabel("📝  Submit LOA Request")
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}

export async function postRafflePanel(channel: TextChannel) {
  const embed = new EmbedBuilder()
    .setTitle("🎡  RAFFLE BOARD")
    .setColor(0x9b59b6)
    .setDescription(
      "**Tokyo Drift Customs — Raffles**\n\n" +
      "This is where raffles are posted. Keep an eye out for new drops! 🍀\n\n" +
      "**How it works:**\n" +
      "• Owners create raffles with the **Create Raffle** button below\n" +
      "• When a raffle is live, click **Enter Raffle** to throw your name in\n" +
      "• The owner spins the wheel — winner is pinged right here"
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Good luck! 🍀" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("admin:setup:createraffle")
      .setLabel("🎡  Create Raffle")
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}

export async function postTimeclockPanel(channel: TextChannel) {
  const panelEmbed = new EmbedBuilder()
    .setTitle("⏰  TIME CLOCK")
    .setColor(0x0d0d0d)
    .setDescription(
      "**Tokyo Drift Customs — Shift Tracker**\n\n" +
      "Click **Clock In** when your shift starts.\n" +
      "Click **Clock Out** when you're done — it'll log your total time and orders completed.\n\n" +
      "*Only mechanics and above can use these buttons.*"
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();

  const clockRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("clockin:panel").setLabel("🟢  Clock In").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("clockout:panel").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({ embeds: [panelEmbed], components: [clockRow] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
