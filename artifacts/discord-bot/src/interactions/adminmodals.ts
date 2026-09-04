import {
  ModalSubmitInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits, TextChannel, EmbedBuilder
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, setGuildConfig, setGuildCrewRate, splitRoleIds, checkpointDatabase } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildJobEmbed, COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { postOrderPanel } from "./orderpanel.js";
import { postTimeclockPanel, postLoaPanel, postRafflePanel, postLifetimeEarningsPanel, CHANNEL_MAP } from "./adminbuttons.js";

export async function handleAdminModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parts = interaction.customId.split(":");
  const [ns, section, action] = parts;
  if (ns !== "admin") return false;

  const guild = interaction.guild!;

  // ── Job Post ───────────────────────────────────────────────────────────────
  if (section === "jobpost") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const title = interaction.fields.getTextInputValue("title");
    const body  = interaction.fields.getTextInputValue("body");
    const poster = await getProfile(interaction.user.id);
    const jobId = randomUUID();
    const embed = buildJobEmbed(title, body, poster?.display_name ?? interaction.user.username);
    const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`job:apply:${jobId}`).setLabel("📩  Apply Now").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`job:delete:${jobId}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger)
    );

    let msgId = "";
    const config = await getGuildConfig(guild.id);
    if (config?.jobs_channel_id) {
      try {
        const ch = await guild.channels.fetch(config.jobs_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).send({ embeds: [embed], components: [applyRow] });
          msgId = msg.id;
        }
      } catch { /* ignore */ }
    }

    await db.execute({
      sql: "INSERT INTO jobs (id, posted_by, title, body, discord_message_id) VALUES (?, ?, ?, ?, ?)",
      args: [jobId, interaction.user.id, title, body, msgId]
    });

    await interaction.editReply({
      content: msgId
        ? `✅ Job **${title}** posted to <#${config?.jobs_channel_id}>!`
        : `✅ Job **${title}** saved — configure a jobs channel first to post it publicly.`
    });
    return true;
  }

  // ── Commission: set trainer crew cut % ───────────────────────────────────
  if (section === "commission" && action === "trainerrate") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rateStr = interaction.fields.getTextInputValue("rate").replace(/%/g, "").trim();
    const pct = parseFloat(rateStr);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await interaction.editReply({ content: "❌ Invalid rate — enter a number between 0 and 100 (e.g. `10` for 10%)." });
      return true;
    }
    const rate = pct / 100;
    await setGuildCrewRate(guild.id, "trainer_crew_rate", rate);
    const embed = new EmbedBuilder()
      .setTitle("📚 Trainer Crew Cut Updated")
      .setColor(COLORS.approved)
      .setDescription(`Trainers will now earn **${pct.toFixed(0)}%** of all mechanic-role order labour per pay period.`)
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  // ── Commission: set manager crew cut % ───────────────────────────────────
  if (section === "commission" && action === "managerrate") {
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rateStr = interaction.fields.getTextInputValue("rate").replace(/%/g, "").trim();
    const pct = parseFloat(rateStr);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await interaction.editReply({ content: "❌ Invalid rate — enter a number between 0 and 100 (e.g. `20` for 20%)." });
      return true;
    }
    const rate = pct / 100;
    await setGuildCrewRate(guild.id, "manager_crew_rate", rate);
    const embed = new EmbedBuilder()
      .setTitle("👔 Manager Crew Cut Updated")
      .setColor(COLORS.approved)
      .setDescription(`Managers will now earn **${pct.toFixed(0)}%** of all mechanic+trainer-role order labour per pay period.`)
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  // ── Commission: set rate ───────────────────────────────────────────────────
  if (section === "commission" && action === "set") {
    const mechanicId = parts[3];
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const rateStr = interaction.fields.getTextInputValue("rate").replace(/%/g, "").trim();
    const pct = parseFloat(rateStr);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await interaction.editReply({ content: "❌ Invalid rate — enter a number between 0 and 100 (e.g. `30` for 30%)." });
      return true;
    }
    const rate = pct / 100;

    const [profile, caller] = await Promise.all([getProfile(mechanicId), getProfile(interaction.user.id)]);
    if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return true; }

    await db.execute({ sql: "UPDATE profiles SET commission_rate = ? WHERE discord_id = ?", args: [rate, mechanicId] });
    await checkpointDatabase();

    const embed = new EmbedBuilder()
      .setTitle("💰 Commission Rate Updated")
      .setColor(COLORS.approved)
      .addFields(
        { name: "Mechanic",  value: profile.display_name,                              inline: true },
        { name: "Old Rate",  value: `${(profile.commission_rate * 100).toFixed(0)}%`,  inline: true },
        { name: "New Rate",  value: `${pct.toFixed(0)}%`,                              inline: true },
        { name: "Updated By", value: caller?.display_name ?? interaction.user.username, inline: true }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Refresh the mechanic's order panel live so commission shows immediately
    if (profile.sales_channel_id) {
      try {
        const salesCh = await guild.channels.fetch(profile.sales_channel_id);
        if (salesCh?.isTextBased()) {
          await postOrderPanel(salesCh as TextChannel, mechanicId, profile.display_name, rate);
        }
      } catch { /* ignore — channel may not exist or bot lacks permissions */ }
    }

    try {
      const config = await getGuildConfig(guild.id);
      if (config?.log_channel_id) {
        const ch = await guild.channels.fetch(config.log_channel_id);
        if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
      }
    } catch { /* ignore */ }
    return true;
  }

  // ── Commission: set manager override rate ─────────────────────────────────
  if (section === "commission" && action === "setoverride") {
    const managerId = parts[3];
    if (!(await requireRole(interaction, "owner"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const rateStr = interaction.fields.getTextInputValue("override_rate").replace(/%/g, "").trim();
    const pct = parseFloat(rateStr);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await interaction.editReply({ content: "❌ Invalid rate — enter a number between 0 and 100 (e.g. `20` for 20%)." });
      return true;
    }
    const rate = pct / 100;

    const [profile, caller] = await Promise.all([getProfile(managerId), getProfile(interaction.user.id)]);
    if (!profile) { await interaction.editReply({ content: "❌ Manager not found." }); return true; }

    await db.execute({ sql: "UPDATE profiles SET manager_override_rate = ? WHERE discord_id = ?", args: [rate, managerId] });
    await checkpointDatabase();

    // Count how many mechanics are assigned to this manager
    const mechanicsR = await db.execute({ sql: "SELECT COUNT(*) FROM profiles WHERE manager_id = ?", args: [managerId] });
    const mechanicCount = Number(mechanicsR.rows[0]?.[0] ?? 0);

    const embed = new EmbedBuilder()
      .setTitle("💼 Manager Override Rate Updated")
      .setColor(COLORS.approved)
      .addFields(
        { name: "Manager",       value: profile.display_name,                                   inline: true },
        { name: "Old Cut",       value: `${((profile.manager_override_rate ?? 0.20) * 100).toFixed(0)}%`, inline: true },
        { name: "New Cut",       value: `${pct.toFixed(0)}%`,                                   inline: true },
        { name: "Mechanics",     value: `${mechanicCount} assigned`,                             inline: true },
        { name: "Updated By",    value: caller?.display_name ?? interaction.user.username,       inline: true }
      )
      .setDescription(`**${profile.display_name}** will now earn **${pct.toFixed(0)}%** of each assigned mechanic's commission on every completed order.`)
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    try {
      const config = await getGuildConfig(guild.id);
      if (config?.log_channel_id) {
        const ch = await guild.channels.fetch(config.log_channel_id);
        if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
      }
    } catch { /* ignore */ }
    return true;
  }

  // ── Sales Channel: Create New ──────────────────────────────────────────────
  if (section === "saleschan" && action === "new") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const mechanicId = interaction.fields.getTextInputValue("mechanic_id").trim();
    const profile = await getProfile(mechanicId);
    if (!profile) {
      await interaction.editReply({ content: "❌ Mechanic not found. Make sure they're added via `/crew add` first." });
      return true;
    }

    const config = await getGuildConfig(guild.id);
    const channelName = `sales-${profile.display_name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;

    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]
      });
    }
    permOverwrites.push({
      id: mechanicId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    for (const rid of [...splitRoleIds(config?.owner_role_id), ...splitRoleIds(config?.manager_role_id), ...splitRoleIds(config?.trainer_role_id)]) {
      permOverwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    const managersR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
    for (const row of managersR.rows) {
      const mid = String(row[0]);
      if (!mid || mid === mechanicId) continue;
      try {
        await guild.members.fetch(mid);
        permOverwrites.push({ id: mid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      } catch { /* member not in server */ }
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
    let amNewPinned = false;
    try {
      const amNewResult = await postOrderPanel(channel, mechanicId, profile.display_name, profile.commission_rate);
      amNewPinned = amNewResult.pinned;
    } catch { /* ignore */ }

    await interaction.editReply({
      content: amNewPinned
        ? `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nThe order panel has been pinned.`
        : `✅ Sales channel created for **${profile.display_name}**: <#${channel.id}>\nOrder panel sent — give the bot **Manage Messages** permission in that channel so it can be pinned.`
    });
    return true;
  }

  // ── Sales Channel: Attach Existing ────────────────────────────────────────
  if (section === "saleschan" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    let amExistPosted = false;
    let amExistPinned = false;
    try {
      const amExistResult = await postOrderPanel(ch as TextChannel, mechanicId, profile.display_name, profile.commission_rate);
      amExistPosted = true;
      amExistPinned = amExistResult.pinned;
    } catch { /* ignore */ }

    let amExistMsg = `✅ Attached <#${channelId}> as **${profile.display_name}**'s sales channel.`;
    if (!amExistPosted) {
      amExistMsg += `\n⚠️ Could not post the order panel — make sure the bot has **Send Messages** and **Embed Links** permission in that channel, then use **Resend Panel** from the admin setup.`;
    } else if (!amExistPinned) {
      amExistMsg += `\n✅ Order panel sent.\n⚠️ Could not pin it — give the bot **Manage Messages** permission in <#${channelId}> so mechanics can find it easily.`;
    } else {
      amExistMsg += ` Order panel posted and pinned.`;
    }

    await interaction.editReply({ content: amExistMsg });
    return true;
  }

  // ── Timeclock: Attach Existing ─────────────────────────────────────────────
  if (section === "timeclock" && action === "existing") {
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    let ch: any;
    try {
      ch = await guild.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
    } catch {
      await interaction.editReply({ content: "❌ Channel not found." });
      return true;
    }

    await setGuildConfig(guild.id, "timeclock_channel_id", channelId);
    await postTimeclockPanel(ch as TextChannel);
    await interaction.editReply({ content: `✅ Timeclock channel set → <#${channelId}> and panel posted.` });
    return true;
  }

  // ── Generic channel: attach existing ──────────────────────────────────────
  if (section === "chan" && action === "setexisting") {
    const chanType = parts[3];
    const cfg = CHANNEL_MAP[chanType];
    if (!cfg) return false;
    if (!(await requireRole(interaction, "manager"))) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    let ch: any;
    try {
      ch = await guild.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error("Not a text channel");
    } catch {
      await interaction.editReply({ content: "❌ Channel not found." });
      return true;
    }

    await setGuildConfig(guild.id, cfg.field, channelId);

    if (chanType === "loach") {
      await postLoaPanel(ch as TextChannel);
    } else if (chanType === "rafflech") {
      await postRafflePanel(ch as TextChannel);
    } else if (chanType === "lifetimeearnings") {
      await postLifetimeEarningsPanel(ch as TextChannel);
    } else if (chanType === "trainingch") {
      const { postTrainingPanel } = await import("./training.js");
      await postTrainingPanel(ch as TextChannel);
    } else if (chanType === "paylogs") {
      const { postPayLogPanel } = await import("../commands/payall.js");
      await postPayLogPanel(ch as TextChannel, guild);
    }

    const panelTypes = ["loach", "rafflech", "lifetimeearnings", "trainingch", "paylogs"];
    await interaction.editReply({ content: `✅ **${cfg.label}** channel set → <#${channelId}>${panelTypes.includes(chanType) ? " and panel posted." : "."}` });
    return true;
  }

  return false;
}
