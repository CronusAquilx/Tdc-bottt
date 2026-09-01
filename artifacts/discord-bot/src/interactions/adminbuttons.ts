import {
  ButtonInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
  RoleSelectMenuBuilder, UserSelectMenuBuilder,
  TextChannel
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildJobEmbed, COLORS } from "../lib/embeds.js";
import { buildFullCrewSyncEmbed, syncFullCrew } from "../commands/crew.js";
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
    if (!(await requireRole(interaction, "manager"))) return true;
    await showRaffleTypeSelector(interaction);
    return true;
  }

  if (section === "setup" && action === "jobpost") {
    if (!(await requireRole(interaction, "manager"))) return true;
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
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [row] });
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
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [row] });
    return true;
  }

  // ── Sales Channel: Create with no category (top-level) ────────────────────
  // customId: admin:saleschan:create:{mechanicId}
  if (section === "saleschan" && action === "create") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const mechanicId = parts[3];
    if (!mechanicId) return false;

    await interaction.deferUpdate();

    const profile = await getProfile(mechanicId);
    if (!profile) {
      await interaction.editReply({ content: "❌ Mechanic not found. Add them via `/crew add` first.", embeds: [], components: [] });
      return true;
    }

    const config = await getGuildConfig(guild.id);
    const channelName = `sales-${profile.display_name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30)}`;

    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
    }
    permOverwrites.push({ id: mechanicId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    for (const rid of [...splitRoleIds(config?.owner_role_id), ...splitRoleIds(config?.manager_role_id), ...splitRoleIds(config?.trainer_role_id)]) {
      permOverwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    // Individual staff from DB
    try {
      const staffRows = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner','manager','trainer')");
      for (const row of staffRows.rows) {
        const uid = String(row[0]);
        if (!uid || uid === mechanicId) continue;
        try { await guild.members.fetch(uid); permOverwrites.push({ id: uid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }); } catch { /* not in server */ }
      }
    } catch { /* ignore */ }

    let channel: TextChannel;
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `📍 Personal sales channel — ${profile.display_name}`,
        permissionOverwrites: permOverwrites
      }) as TextChannel;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}`, embeds: [], components: [] });
      return true;
    }

    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, mechanicId] });
    let abPinned = false;
    try {
      const abResult = await postOrderPanel(channel, mechanicId, profile.display_name, profile.commission_rate);
      abPinned = abResult.pinned;
    } catch { /* ignore */ }

    await interaction.editReply({
      content: abPinned
        ? `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nThe order panel has been pinned.`
        : `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nOrder panel sent — give the bot **Manage Messages** permission in that channel so it can be pinned.`,
      embeds: [], components: []
    });
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
    await interaction.followUp({ content: "✅ Panel refreshed.", flags: MessageFlags.Ephemeral });
    return true;
  }

  // ── Panel tab: Staff ──────────────────────────────────────────────────────
  if (section === "panel" && action === "staff") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder()
      .setTitle("👥  STAFF MANAGEMENT")
      .setColor(COLORS.primary)
      .setDescription(
        "**Crew & shift management tools.**\n\n" +
        "• **Sales Channel** — create or attach a mechanic's personal order channel\n" +
        "• **Resend Panel** — re-post a stuck order panel to a mechanic's channel\n" +
        "• **Job Post** — post a hiring ad to the jobs channel\n" +
        "• **LOA** — submit a Leave of Absence request\n" +
        "• **Timeclock** — set up the clock-in/clock-out channel\n" +
        "• **Full Crew Sync** — import members with the mechanic role and link matching sales channels"
      )
      .setFooter({ text: FOOTER });
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:saleschannel").setLabel("➕  Sales Channel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:saleschan:resend").setLabel("🔄  Resend Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:timeclock").setLabel("⏰  Timeclock").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:setup:jobpost").setLabel("📢  Post Job Ad").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:setup:loa").setLabel("🌴  Submit LOA").setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:crew:syncfull").setLabel("🔄  Full Crew Sync").setStyle(ButtonStyle.Success),
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    return true;
  }

  // ── Staff: import mechanic-role members and repair sales-channel links ─────
  if (section === "crew" && action === "syncfull") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await syncFullCrew(guild);
      await interaction.editReply({ embeds: [buildFullCrewSyncEmbed(result)] });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Full crew sync failed: ${err?.message ?? "Unknown error"}` });
    }
    return true;
  }

  // ── Sales Channel: Resend order panel ─────────────────────────────────────
  if (section === "saleschan" && action === "resend") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("🔄  Resend Order Panel")
      .setColor(COLORS.primary)
      .setDescription("Pick the mechanic whose order panel you want to re-post to their sales channel.")
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:saleschan:pickmechanic:resend")
        .setPlaceholder("Select a mechanic...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [row] });
    return true;
  }

  // ── Panel tab: Channels ───────────────────────────────────────────────────
  if (section === "panel" && action === "channels") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
        `⏰ Clock Panel: ${ch(config?.timeclock_channel_id)}\n` +
        `📋 Clock Logs: ${ch(config?.clocklog_channel_id)}\n` +
        `🎰 Raffle: ${ch(config?.raffle_channel_id)}\n` +
        `🏆 Leaderboard: ${ch(config?.leaderboard_channel_id)}\n` +
        `📚 Training: ${ch(config?.training_channel_id)}\n` +
        `💸 Pay Logs: ${ch(config?.payday_channel_id)}\n` +
        `🏆 Lifetime Earnings: ${ch(config?.lifetime_earnings_channel_id)}`
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
      new ButtonBuilder().setCustomId("admin:setup:timeclock").setLabel("⏰ Clock Panel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:clocklogch").setLabel("📋 Clock Logs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:rafflech").setLabel("🎰 Raffle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:leaderboard").setLabel("🏆 Leaderboard").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setup:trainingch").setLabel("📚 Training").setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setup:paylogs").setLabel("💸 Pay Logs").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:setup:lifetimeearnings").setLabel("🏆 Lifetime Earnings").setStyle(ButtonStyle.Primary),
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2, row3] });
    return true;
  }

  // ── Panel tab: Raffle ─────────────────────────────────────────────────────
  if (section === "panel" && action === "raffle") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

  // ── Panel tab: Payroll ────────────────────────────────────────────────────
  if (section === "panel" && action === "payroll") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

    // Pull every profile and their current-period labour
    const crewR = await db.execute({
      sql: `SELECT p.discord_id, p.display_name, p.commission_rate, p.commission_adjustment,
                   COALESCE(SUM(o.labour), 0) AS week_labour, COUNT(o.id) AS order_count,
                   p.commission_labour_snapshot, p.current_pay_status
            FROM profiles p
            LEFT JOIN orders o ON o.mechanic_id = p.discord_id
              AND o.status IN ('complete', 'approved', 'paid')
              AND datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(
                    COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01')
                  )
            GROUP BY p.discord_id
            ORDER BY p.display_name`,
      args: []
    });

    // Fetch manager cuts so they show in their own commission line
    const managersR = await db.execute(
      "SELECT p.discord_id, p.manager_override_rate, p.manager_cut_adjustment, p.manager_labour_snapshot FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
    );
    const managerCutMap = new Map<string, number>();
    for (const mrow of managersR.rows) {
      const managerId    = String(mrow[0] ?? "");
      const overrideRate = Number(mrow[1] ?? 0.20);
      const manualBonus  = Number(mrow[2] ?? 0);
      const managerSnap  = Number(mrow[3] ?? 0);
      const crewLabourR  = await db.execute({
        sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved','paid') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
        args: [managerId]
      });
      const crewLabour    = Number(crewLabourR.rows[0]?.[0] ?? 0);
      const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
      const cut = manualBonus > 0
        ? manualBonus + crewAfterSnap * overrideRate
        : crewLabour * overrideRate;
      managerCutMap.set(managerId, cut);
    }

    const lines: string[] = [];
    let grandTotal = 0;
    for (const row of crewR.rows) {
      const discordId = String(row[0] ?? "");
      const name      = String(row[1] ?? "Unknown");
      const rate      = Number(row[2] ?? 0.3);
      const override  = Number(row[3] ?? 0);
      const labour    = Number(row[4] ?? 0);
      const orders    = Number(row[5] ?? 0);
      const snapshot  = Number(row[6] ?? 0);
      const labourAfterSetpay = Math.max(0, labour - snapshot);
      const ownComm = override > 0
        ? override + labourAfterSetpay * rate
        : labour * rate;
      const managerCut = managerCutMap.get(discordId) ?? 0;
      const totalComm  = ownComm + managerCut;
      grandTotal += totalComm;
      const rateLabel = override > 0
        ? `set ${Math.round(override).toLocaleString()} + new orders`
        : `${(rate * 100).toFixed(0)}%`;
      const ordNote = orders > 0 ? ` · ${orders} order${orders === 1 ? "" : "s"}` : " · no orders";
      const cutNote = managerCut > 0 ? ` + **${Math.round(managerCut).toLocaleString()} mgr cut**` : "";
      const payStatus = row[7] ? String(row[7]) : "pending";
      const payEmoji  = payStatus === "paid" ? "💚" : "🔴";
      lines.push(`${payEmoji} **${name}**${ordNote} · ${rateLabel} → **${Math.round(ownComm).toLocaleString()}**${cutNote} = **${Math.round(totalComm).toLocaleString()}**`);
    }

    const crewBlock = lines.length ? lines.join("\n") : "*No crew profiles found.*";

    // Split lines across multiple fields so no one gets cut off (Discord 1024 char limit per field)
    const crewFields: { name: string; value: string; inline: boolean }[] = [];
    let chunk = "";
    let chunkIndex = 0;
    for (const line of lines) {
      const addition = (chunk ? "\n" : "") + line;
      if (chunk.length + addition.length > 1020) {
        crewFields.push({ name: chunkIndex === 0 ? `👥 Crew (${crewR.rows.length})` : "​", value: chunk, inline: false });
        chunk = line;
        chunkIndex++;
      } else {
        chunk += addition;
      }
    }
    if (chunk) crewFields.push({ name: chunkIndex === 0 ? `👥 Crew (${crewR.rows.length})` : "​", value: chunk, inline: false });
    if (!crewFields.length) crewFields.push({ name: `👥 Crew (0)`, value: "*No crew profiles found.*", inline: false });

    const embed = new EmbedBuilder()
      .setTitle("💸  PAYROLL")
      .setColor(0xffd700)
      .setDescription(
        "**Current pay period commission summary.**  💚 = paid  🔴 = pending\n\n" +
        "• **Set Individual Pay** — override a mechanic's commission for this period\n" +
        "• **Pay All** — process payroll, notify crew, and log payouts\n" +
        "• **Mark Paid / Pending** — track who's been paid this week\n" +
        "• **Start New Week** — clear, reset stats, and send the new week message\n\n" +
        "💡 *You can also use `/payall` or `/pay @user` commands directly.*"
      )
      .addFields(
        ...crewFields,
        { name: "💰 Total to Bill Company", value: `**${Math.round(grandTotal).toLocaleString()}**`, inline: true }
      )
      .setFooter({ text: FOOTER });

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:payroll:setpay").setLabel("💰 Set Individual Pay").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("payall:schedulenow").setLabel("📅 Pay All").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:payroll:lifetimeearnings").setLabel("🏆 Lifetime Earnings").setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:payroll:markpaid").setLabel("💚 Mark Paid").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:payroll:markunpaid").setLabel("🔴 Mark Pending").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("admin:payroll:newweek").setLabel("🔄 Start New Week").setStyle(ButtonStyle.Primary),
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    return true;
  }

  // ── Payroll: mark individual as paid ─────────────────────────────────────
  if (section === "payroll" && action === "markpaid") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("💚  Mark as Paid")
      .setColor(COLORS.approved)
      .setDescription("Pick the crew member to mark as **paid** this week.\n\n💡 *This does not process a payout — use **Pay All** for that.*")
      .setFooter({ text: FOOTER });
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:payroll:pickmarkpaid")
        .setPlaceholder("Select a crew member...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Payroll: mark individual as pending ───────────────────────────────────
  if (section === "payroll" && action === "markunpaid") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("🔴  Mark as Pending")
      .setColor(COLORS.warning)
      .setDescription("Pick the crew member to mark as **pending** (not yet paid) this week.")
      .setFooter({ text: FOOTER });
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:payroll:pickmarkunpaid")
        .setPlaceholder("Select a crew member...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Payroll: start new week confirmation ──────────────────────────────────
  if (section === "payroll" && action === "newweek") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder()
      .setTitle("🔄  Start New Week — Confirm")
      .setColor(COLORS.warning)
      .setDescription(
        "This will:\n\n" +
        "• 🗃️ Archive all completed orders and delete all drafts\n" +
        "• 📊 Reset everyone's hours, commission, and stat snapshots to zero\n" +
        "• 🔴 Reset everyone's pay status to **Pending**\n" +
        "• 📢 Send a new week message to every sales channel\n" +
        "• 🏆 Post a fresh leaderboard (if channel is configured)\n\n" +
        "⚠️ **Run Pay All first if you want everyone paid before the reset!**"
      )
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("payroll:newweek:confirm").setLabel("✅ Start New Week").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("payroll:newweek:cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return true;
  }

  // ── Payroll: post lifetime earnings to configured channel ─────────────────
  if (section === "payroll" && action === "lifetimeearnings") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = await getGuildConfig(guild.id);
    const chanId = config?.lifetime_earnings_channel_id;
    if (!chanId) {
      await interaction.editReply({ content: "❌ Lifetime Earnings channel not set up yet. Use the **Channels** tab to configure it first." });
      return true;
    }
    try {
      const ch = await guild.channels.fetch(chanId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
      await postLifetimeEarningsPanel(ch as TextChannel);
      await interaction.editReply({ content: `✅ Lifetime Earnings posted to <#${chanId}>` });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to post: ${err?.message ?? "Unknown error"}` });
    }
    return true;
  }

  // ── Payroll: set individual pay — pick member ─────────────────────────────
  if (section === "payroll" && action === "setpay") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("💰  Set Individual Commission")
      .setColor(0xffd700)
      .setDescription(
        "Pick the crew member whose commission you want to override for this pay period.\n\n" +
        "This sets a **fixed dollar amount** that replaces the calculated commission.\n" +
        "Set it to `0` to clear the override and go back to the % calculation."
      )
      .setFooter({ text: FOOTER });
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new USM()
        .setCustomId("admin:payroll:pickmember")
        .setPlaceholder("Select a crew member...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Panel tab: Config ─────────────────────────────────────────────────────
  if (section === "panel" && action === "config") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = await getGuildConfig(guild.id);
    const roMany = (s: string | null | undefined) => {
      const ids = splitRoleIds(s);
      return ids.length ? ids.map(id => `<@&${id}>`).join(", ") : "`Not set`";
    };
    const embed = new EmbedBuilder()
      .setTitle("⚙️  SERVER CONFIG")
      .setColor(COLORS.dark)
      .setDescription(
        "**Configure role assignments and commission rates.**\n" +
        "*You can assign multiple roles per level — all selected roles will be accepted.*\n\n" +
        `👑 Owner: ${roMany(config?.owner_role_id)}\n` +
        `🔧 Manager: ${roMany(config?.manager_role_id)}\n` +
        `📚 Trainer: ${roMany(config?.trainer_role_id)}\n` +
        `🔩 Mechanic: ${roMany(config?.mechanic_role_id)}\n` +
        `🎓 Needs Training: ${roMany((config as any)?.needs_training_role_id)}\n\n` +
        "*Members with **Administrator** permission can always use all commands regardless of role.*"
      )
      .setFooter({ text: FOOTER });
    const roleRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:roles:set:owner").setLabel("👑 Owner Role").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:roles:set:manager").setLabel("🔧 Manager Role").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:roles:set:trainer").setLabel("📚 Trainer Role").setStyle(ButtonStyle.Secondary),
    );
    const roleRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:roles:set:mechanic").setLabel("🔩 Mechanic Role").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:roles:set:needs_training").setLabel("🎓 Needs Training").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:commission:pick").setLabel("💰 Set Commission").setStyle(ButtonStyle.Primary),
    );
    const roleRow3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:assign:manager").setLabel("👤 Assign Manager").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:commission:pickoverride").setLabel("💼 Manager Cut %").setStyle(ButtonStyle.Secondary),
    );
    const roleRow4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:setrole:assign:trainer").setLabel("🎓 Add as Trainer").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:setrole:assign:manager").setLabel("👔 Add as Manager").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:commission:settrainerrate").setLabel("📚 Trainer Cut %").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin:commission:setmanagerrate").setLabel("👔 Manager Cut %").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [roleRow1, roleRow2, roleRow3, roleRow4] });
    return true;
  }

  // ── Config: set role level ────────────────────────────────────────────────
  if (section === "roles" && action === "set") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const level = parts[3] as "owner" | "manager" | "trainer" | "mechanic" | "needs_training";
    const levelLabels: Record<string, string> = {
      owner: "👑 Owner", manager: "🔧 Manager", trainer: "📚 Trainer",
      mechanic: "🔩 Mechanic", needs_training: "🎓 Needs Training"
    };
    const { RoleSelectMenuBuilder: RSM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle(`🎭  Set ${levelLabels[level] ?? level} Role`)
      .setColor(COLORS.dark)
      .setDescription(`Pick the Discord role that maps to **${levelLabels[level] ?? level}** access.`)
      .setFooter({ text: FOOTER });
    const roleSelect = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RSM()
        .setCustomId(`setup:setrole:${level}`)
        .setPlaceholder(`Pick all roles for ${level} access (replaces current list)...`)
        .setMinValues(1).setMaxValues(10)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [roleSelect] });
    return true;
  }

  // ── Config: pick mechanic for commission ──────────────────────────────────
  if (section === "commission" && action === "pick") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const embed = new EmbedBuilder()
      .setTitle("💰  Set Individual Commission")
      .setColor(COLORS.primary)
      .setDescription("Pick the mechanic whose commission rate you want to change.")
      .setFooter({ text: FOOTER });
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const userSelect = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new USM()
        .setCustomId("admin:commission:pickmechanic")
        .setPlaceholder("Select a mechanic...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [userSelect] });
    return true;
  }

  // ── Config: set manager override rate (pick manager) ─────────────────────
  if (section === "commission" && action === "pickoverride") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("💼  Set Manager Override Rate")
      .setColor(COLORS.primary)
      .setDescription(
        "Pick the **manager** whose override cut % you want to set.\n\n" +
        "The override cut is the % of commission the manager earns from every mechanic assigned to them.\n" +
        "*Default is 20%. Their own order commission is set separately via 💰 Set Commission.*"
      )
      .setFooter({ text: FOOTER });
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new USM()
        .setCustomId("admin:commission:pickmanageroverride")
        .setPlaceholder("Pick a manager...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Config: assign mechanic → manager (step 1: pick mechanic) ─────────────
  if (section === "assign" && action === "manager") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("👤  Assign Manager")
      .setColor(COLORS.dark)
      .setDescription(
        "**How do you want to pick mechanics to assign?**\n\n" +
        "👤 **Pick User** — select one mechanic manually\n" +
        "🔩 **By Role** — pick a role and multi-select everyone with that role"
      )
      .setFooter({ text: FOOTER });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:assign:pickmechanic:manual").setLabel("👤 Pick User").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin:assign:byrolepicker").setLabel("🔩 By Role").setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [row] });
    return true;
  }

  // ── Config: assign by role — show role picker ─────────────────────────────
  if (section === "assign" && action === "byrolepicker") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { RoleSelectMenuBuilder: RSM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("🔩  Assign by Role — Step 1")
      .setColor(COLORS.dark)
      .setDescription("Pick the **role** whose members you want to assign to a manager.\nThe bot will then show all members with that role for multi-select.")
      .setFooter({ text: FOOTER });
    const roleRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RSM()
        .setCustomId("admin:assignbyrole:pickrole")
        .setPlaceholder("Select the mechanic role...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [roleRow] });
    return true;
  }

  // ── Config: assign mechanic → manager (manual, step 1: pick mechanic) ──────
  if (section === "assign" && action === "pickmechanic" && parts[3] === "manual") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("👤  Assign Manager — Step 1 of 2")
      .setColor(COLORS.dark)
      .setDescription("Select the **mechanic** you want to assign a manager to.")
      .setFooter({ text: FOOTER });
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new USM()
        .setCustomId("admin:assign:pickmechanic")
        .setPlaceholder("Pick a mechanic...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Crew rate: set trainer cut % ──────────────────────────────────────────
  if (section === "commission" && action === "settrainerrate") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = await import("discord.js");
    const modal = new ModalBuilder().setCustomId("admin:commission:trainerrate").setTitle("📚 Set Trainer Crew Cut %");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("rate")
          .setLabel("Trainer cut % of mechanic labour (e.g. 10)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("10")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // ── Crew rate: set manager cut % ──────────────────────────────────────────
  if (section === "commission" && action === "setmanagerrate") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const { ModalBuilder, TextInputBuilder, TextInputStyle } = await import("discord.js");
    const modal = new ModalBuilder().setCustomId("admin:commission:managerrate").setTitle("👔 Set Manager Crew Cut %");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("rate")
          .setLabel("Manager cut % of crew labour (e.g. 20)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("20")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // ── Assign user as trainer (manual, step 1) ────────────────────────────────
  if (section === "setrole" && action === "assign") {
    if (!(await requireRole(interaction, "manager"))) return true;
    const roleTarget = parts[3] as "trainer" | "manager";
    const roleLabel = roleTarget === "trainer" ? "📚 Add as Trainer" : "👔 Add as Manager";
    const { UserSelectMenuBuilder: USM } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle(`${roleLabel}`)
      .setColor(COLORS.dark)
      .setDescription(`Select the member to grant **${roleTarget}** role in the bot database.\n\nThis supplements Discord role detection — they will be recognized as ${roleTarget} even without the Discord role.`)
      .setFooter({ text: FOOTER });
    const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new USM()
        .setCustomId(`admin:setrole:pickmember:${roleTarget}`)
        .setPlaceholder(`Pick a member to make ${roleTarget}...`)
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: [sel] });
    return true;
  }

  // ── Sales Channel setup ────────────────────────────────────────────────────
  if (section === "setup" && action === "saleschannel") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
        // Everyone can see the panel but cannot send messages (only use buttons)
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      ];
      if (guild.members.me) {
        permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
      }
      const ch = await guild.channels.create({
        name: "tdc-clock-panel",
        type: ChannelType.GuildText,
        topic: "⏰ Tokyo Drift Customs — Clock in and out using the buttons below",
        permissionOverwrites: permOverwrites
      }) as TextChannel;
      await postTimeclockPanel(ch);
      await setGuildConfig(guild.id, "timeclock_channel_id", ch.id);
      await interaction.followUp({ content: `✅ Clock panel created → <#${ch.id}>\n\n💡 **Next step:** Set up a **Clock Logs** channel so clock-in/out records go there instead of the panel.`, flags: MessageFlags.Ephemeral });
    } catch (err: any) {
      await interaction.followUp({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return true;
  }

  // ── Generic channel setups (Orders, Jobs, Logs, Archive, LOA, Raffle) ──────
  if (section === "setup" && action in CHANNEL_MAP) {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      await postChannelPanel(ch, chanType, guild);
      await interaction.followUp({ content: `✅ **#${cfg.name}** created → <#${ch.id}>`, flags: MessageFlags.Ephemeral });
    } catch (err: any) {
      await interaction.followUp({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel map (used for generic setup + modal attach flows)
// ─────────────────────────────────────────────────────────────────────────────
export const CHANNEL_MAP: Record<string, {
  field: "orders_channel_id" | "jobs_channel_id" | "log_channel_id" | "archive_channel_id" | "loa_channel_id" | "raffle_channel_id" | "leaderboard_channel_id" | "training_channel_id" | "clocklog_channel_id" | "payday_channel_id" | "lifetime_earnings_channel_id";
  name: string; topic: string; label: string;
}> = {
  orders:           { field: "orders_channel_id",             name: "tdc-orders",           topic: "Tokyo Drift Customs — Order submissions",             label: "Orders"           },
  jobs:             { field: "jobs_channel_id",               name: "tdc-jobs",             topic: "Tokyo Drift Customs — Job postings",                 label: "Jobs"             },
  logs:             { field: "log_channel_id",                name: "tdc-logs",             topic: "Tokyo Drift Customs — System logs",                  label: "Logs"             },
  archive:          { field: "archive_channel_id",            name: "tdc-archive",          topic: "Tokyo Drift Customs — Archived orders",              label: "Archive"          },
  loach:            { field: "loa_channel_id",                name: "tdc-loa",              topic: "Tokyo Drift Customs — Leave of Absence",             label: "LOA"              },
  rafflech:         { field: "raffle_channel_id",             name: "tdc-raffle",           topic: "Tokyo Drift Customs — Raffles",                      label: "Raffle"           },
  leaderboard:      { field: "leaderboard_channel_id",        name: "tdc-leaderboard",      topic: "Tokyo Drift Customs — Weekly Leaderboard",           label: "Leaderboard"      },
  trainingch:       { field: "training_channel_id",           name: "tdc-training",         topic: "Tokyo Drift Customs — Training Sessions",            label: "Training"         },
  clocklogch:       { field: "clocklog_channel_id",           name: "tdc-clock-logs",       topic: "Tokyo Drift Customs — Clock in/out logs",            label: "Clock Logs"       },
  paylogs:          { field: "payday_channel_id",             name: "tdc-pay-logs",         topic: "Tokyo Drift Customs — Payroll logs & payday panels", label: "Pay Logs"         },
  lifetimeearnings: { field: "lifetime_earnings_channel_id",  name: "tdc-lifetime-earnings",topic: "Tokyo Drift Customs — All-time earnings tracker",    label: "Lifetime Earnings"},
};

// ─────────────────────────────────────────────────────────────────────────────
// Panel embeds posted when channels are created or attached
// ─────────────────────────────────────────────────────────────────────────────
async function postChannelPanel(channel: TextChannel, chanType: string, guild?: import("discord.js").Guild) {
  if (chanType === "loach") {
    await postLoaPanel(channel);
  } else if (chanType === "rafflech") {
    await postRafflePanel(channel);
  } else if (chanType === "trainingch") {
    const { postTrainingPanel } = await import("./training.js");
    await postTrainingPanel(channel);
  } else if (chanType === "paylogs") {
    const { postPayLogPanel } = await import("../commands/payall.js");
    await postPayLogPanel(channel, guild);
  } else if (chanType === "lifetimeearnings") {
    await postLifetimeEarningsPanel(channel);
  } else if (chanType === "leaderboard") {
    const { postLeaderboard } = await import("../commands/leaderboard.js");
    await postLeaderboard(channel);
  }
  // orders, jobs, logs, archive, clocklogch — no panel needed
}

export async function buildLifetimeEarningsEmbed(): Promise<EmbedBuilder> {
  const r = await db.execute({
    sql: `SELECT p.discord_id, p.display_name,
                 COALESCE(SUM(po.amount), 0) AS total_paid,
                 COUNT(po.id) AS payout_count
          FROM profiles p
          LEFT JOIN payouts po ON po.mechanic_id = p.discord_id
          GROUP BY p.discord_id
          ORDER BY total_paid DESC`,
    args: []
  });
  const fmt = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const lines = r.rows.map((row, i) => {
    const name  = String(row[1] ?? "Unknown");
    const total = Number(row[2] ?? 0);
    const count = Number(row[3] ?? 0);
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
    return `${medal}  **${name}** — ${fmt(total)} across ${count} payout${count !== 1 ? "s" : ""}`;
  });
  const grandTotal = r.rows.reduce((s, row) => s + Number(row[2] ?? 0), 0);
  return new EmbedBuilder()
    .setTitle("🏆  LIFETIME EARNINGS — TOKYO DRIFT CUSTOMS")
    .setColor(COLORS.gold)
    .setDescription(lines.length ? lines.join("\n") : "*No payouts recorded yet.*")
    .addFields({ name: "💰 Total Paid Out (All Time)", value: `**${fmt(grandTotal)}**`, inline: false })
    .setFooter({ text: "東京ドリフトカスタム  ·  All-time earnings" })
    .setTimestamp();
}

export async function postLifetimeEarningsPanel(channel: TextChannel) {
  const embed = await buildLifetimeEarningsEmbed();
  const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("lifetime:refresh").setLabel("🔄  Refresh").setStyle(ButtonStyle.Secondary)
  );
  const msg = await channel.send({ embeds: [embed], components: [refreshRow] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
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
    .setTitle("⏰  TOKYO DRIFT CUSTOMS  ·  CLOCK PANEL")
    .setColor(0x0d0d0d)
    .setDescription(
      "**Use the buttons below to clock in or out.**\n\n" +
      "• 🟢 **Clock In** — start your shift\n" +
      "• 🔴 **Clock Out** — end your shift\n" +
      "• ⏱️ **Check Time** — see how long you've been clocked in\n\n" +
      "*Your clock-in and clock-out records are posted in the clock logs channel.*"
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("clockin:panel").setLabel("🟢  Clock In").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("clockout:panel").setLabel("🔴  Clock Out").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("checktime:panel").setLabel("⏱️  Check Time").setStyle(ButtonStyle.Secondary),
  );

  const msg = await channel.send({ embeds: [panelEmbed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
