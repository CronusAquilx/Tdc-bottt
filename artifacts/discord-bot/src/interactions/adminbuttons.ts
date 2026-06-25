import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
  RoleSelectMenuBuilder, UserSelectMenuBuilder,
  TextChannel
} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildJobEmbed, COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { postOrderPanel } from "./orderpanel.js";
import { showRaffleTypeSelector } from "./raffle.js";
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
    await showRaffleTypeSelector(interaction);
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
    const embed = new EmbedBuilder()
      .setTitle("➕  Create Sales Channel")
      .setColor(COLORS.primary)
      .setDescription("**Pick the mechanic** this channel is for.\nThe bot will create a private channel and post their order panel.")
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:saleschan:pickmechanic:new")
        .setPlaceholder("Select a mechanic...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
    return true;
  }

  if (section === "saleschan" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("🔗  Attach Existing Sales Channel")
      .setColor(COLORS.primary)
      .setDescription("**Step 1 of 2 — Pick the mechanic** this channel belongs to.")
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:saleschan:pickmechanic:existing")
        .setPlaceholder("Select a mechanic...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
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
    // Just ack — main panel is now tab-based; no embed to update on the base msg
    await interaction.followUp({ content: "✅ Panel refreshed.", ephemeral: true });
    return true;
  }

  // ── Panel tab: Staff ──────────────────────────────────────────────────────
  if (section === "panel" && action === "staff") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("👥  STAFF MANAGEMENT")
      .setColor(COLORS.primary)
      .setDescription(
        "**Crew & shift management tools.**\n\n" +
        "• **Sales Channel** — create or attach a mechanic's personal order channel\n" +
        "• **Job Post** — post a hiring ad to the jobs channel\n" +
        "• **LOA** — submit a Leave of Absence request\n" +
        "• **Timeclock** — set up the clock-in/clock-out channel"
      )
      .setFooter({ text: FOOTER });
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:saleschannel").setLabel("➕  Sales Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:setup:timeclock").setLabel("⏰  Timeclock").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:setup:jobpost").setLabel("📢  Post Job Ad").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:setup:loa").setLabel("🌴  Submit LOA").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row1] });
    return true;
  }

  // ── Panel tab: Channels ───────────────────────────────────────────────────
  if (section === "panel" && action === "channels") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const config = await getGuildConfig(guild.id);
    const ch = (id: string | null | undefined) => id ? `<#${id}>` : "`Not set`";
    const embed = new EmbedBuilder()
      .setTitle("📡  CHANNEL SETUP")
      .setColor(COLORS.submitted)
      .setDescription(
        "**Configure bot channels.**\n\n" +
        `📋 Orders: ${ch(config?.orders_channel_id)}\n` +
        `💼 Jobs: ${ch(config?.jobs_channel_id)}\n` +
        `📜 Logs: ${ch(config?.log_channel_id)}\n` +
        `🗃️ Archive: ${ch(config?.archive_channel_id)}\n` +
        `🌴 LOA: ${ch(config?.loa_channel_id)}\n` +
        `⏰ Timeclock: ${ch(config?.timeclock_channel_id)}\n` +
        `🎰 Raffle: ${ch(config?.raffle_channel_id)}\n` +
        `🏆 Leaderboard: ${ch(config?.leaderboard_channel_id)}\n` +
          `📚 Training: ${ch((config as any)?.training_channel_id)}`
      )
      .setFooter({ text: FOOTER });
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:orders").setLabel("📋 Orders").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:jobs").setLabel("💼 Jobs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:archive").setLabel("🗃️ Archive").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:loach").setLabel("🌴 LOA").setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:timeclock").setLabel("⏰ Timeclock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:rafflech").setLabel("🎰 Raffle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:leaderboard").setLabel("🏆 Leaderboard").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:trainingch").setLabel("📚 Training").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    return true;
  }

  // ── Panel tab: Raffle ─────────────────────────────────────────────────────
  if (section === "panel" && action === "raffle") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const config = await getGuildConfig(guild.id);
    const ch = (id: string | null | undefined) => id ? `<#${id}>` : "`Not set`";
    const embed = new EmbedBuilder()
      .setTitle("🎰  RAFFLE TOOLS")
      .setColor(COLORS.raffle)
      .setDescription(
        "**Manage raffles and the raffle channel.**\n\n" +
        `🎰 Raffle Channel: ${ch(config?.raffle_channel_id)}\n\n` +
        "• **Create Raffle** — launch a new raffle with prizes and wheel\n" +
        "• **Raffle Channel** — set up or attach the raffle channel"
      )
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:createraffle").setLabel("🎡  Create Raffle").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:setup:rafflech").setLabel("🎰  Raffle Channel").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  // ── Panel tab: Config ─────────────────────────────────────────────────────
  if (section === "panel" && action === "config") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ ephemeral: true });
    const config = await getGuildConfig(guild.id);
    const ro = (id: string | null | undefined) => id ? `<@&${id}>` : "`Not set`";
    const embed = new EmbedBuilder()
      .setTitle("⚙️  SERVER CONFIG")
      .setColor(COLORS.dark)
      .setDescription(
        "**Admin permission roles — only Owner and Manager are required.**\n\n" +
        `👑 Owner: ${ro(config?.owner_role_id)}\n` +
        `🔧 Manager: ${ro(config?.manager_role_id)}`
      )
      .setFooter({ text: FOOTER });
    const rows = [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:owner").setPlaceholder("👑 Set Owner role")),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("setup:setrole:manager").setPlaceholder("🔧 Set Manager role")),
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
  field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id" | "loa_channel_id" | "raffle_channel_id" | "leaderboard_channel_id" | "training_channel_id";
  name: string; topic: string; label: string;
}> = {
  orders:      { field: "orders_channel_id",      name: "tdc-orders",      topic: "Tokyo Drift Customs — Order submissions",    label: "Orders"      },
  jobs:        { field: "jobs_channel_id",         name: "tdc-jobs",        topic: "Tokyo Drift Customs — Job postings",         label: "Jobs"        },
  logs:        { field: "log_channel_id",          name: "tdc-logs",        topic: "Tokyo Drift Customs — System logs",          label: "Logs"        },
  archive:     { field: "archive_channel_id",      name: "tdc-archive",     topic: "Tokyo Drift Customs — Archived orders",      label: "Archive"     },
  loach:       { field: "loa_channel_id",          name: "tdc-loa",         topic: "Tokyo Drift Customs — Leave of Absence",     label: "LOA"         },
  rafflech:    { field: "raffle_channel_id",       name: "tdc-raffle",      topic: "Tokyo Drift Customs — Raffles",              label: "Raffle"      },
  leaderboard: { field: "leaderboard_channel_id",  name: "tdc-leaderboard", topic: "Tokyo Drift Customs — Weekly Leaderboard",   label: "Leaderboard" },
  trainingch:  { field: "training_channel_id",     name: "tdc-training",    topic: "Tokyo Drift Customs — Training Sessions",    label: "Training"    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Panel embeds posted when channels are created or attached
// ─────────────────────────────────────────────────────────────────────────────
async function postChannelPanel(channel: TextChannel, chanType: string) {
  if (chanType === "loach") {
    await postLoaPanel(channel);
  } else if (chanType === "rafflech") {
    await postRafflePanel(channel);
  } else if (chanType === "trainingch") {
    const { postTrainingPanel } = await import("./training.js");
    await postTrainingPanel(channel);
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
      "Click **Clock Out** when you're done — it'll log your total time and orders completed."
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
