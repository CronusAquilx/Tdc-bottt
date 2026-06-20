import {
  ButtonInteraction, ModalSubmitInteraction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ChannelType, PermissionFlagsBits,
  TextChannel
} from "discord.js";
import { db, getProfile, getGuildConfig, getUserRole } from "../db.js";
import { COLORS } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";
import { postOrderPanel } from "./orderpanel.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

// ── Button: "Schedule Training" from the training channel panel ────────────────
export async function handleTrainingButton(interaction: ButtonInteraction): Promise<boolean> {
  const [ns, action, ...rest] = interaction.customId.split(":");

  if (ns === "training" && action === "schedule") {
    const modal = new ModalBuilder()
      .setCustomId("training:modal:schedule")
      .setTitle("Schedule Training Session");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("your_name")
          .setLabel("Your in-city name / IGN")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("time_available")
          .setLabel("When are you free? (date + time)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setPlaceholder("e.g. Saturday June 21 around 7PM EST")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("has_city_job")
          .setLabel("Do you have a city job? (yes / no)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setPlaceholder("yes or no")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("has_sales_channel")
          .setLabel("Do you have a sales channel? (yes / no)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setPlaceholder("yes or no")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // Close training channel button
  if (ns === "training" && action === "close") {
    const guild = interaction.guild!;
    const role = await getUserRole(interaction.user.id);
    const allowed = ["owner", "manager", "trainer"];
    if (!role || !allowed.includes(role)) {
      await interaction.reply({ content: "❌ Only owners, managers, and trainers can close training channels.", ephemeral: true });
      return true;
    }
    await interaction.deferUpdate();
    try {
      await interaction.channel?.delete();
    } catch {
      await interaction.followUp({ content: "❌ Failed to delete channel.", ephemeral: true });
    }
    return true;
  }

  // Create sales channel from training channel button
  // customId: training:createsaleschan:{recruitId}:{safeName}
  if (ns === "training" && action === "createsaleschan") {
    const recruitId = rest[0];
    const safeName  = rest.slice(1).join(":");

    const role = await getUserRole(interaction.user.id);
    const allowed = ["owner", "manager", "trainer"];
    if (!role || !allowed.includes(role)) {
      await interaction.reply({ content: "❌ Only trainers, managers, and owners can create sales channels.", ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild!;
    const config = await getGuildConfig(guild.id);

    // Get or build display name
    let displayName = safeName.replace(/-/g, " ");
    const profile = await getProfile(recruitId);
    if (profile) displayName = profile.display_name;

    const channelName = `sales-${safeName.slice(0, 30)}`;

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
    permOverwrites.push({
      id: recruitId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
      permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    try {
      const staffR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
      for (const row of staffR.rows) {
        const sid = String(row[0] ?? "");
        if (!sid || sid === recruitId) continue;
        try {
          await guild.members.fetch(sid);
          permOverwrites.push({ id: sid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        } catch { /* not in server */ }
      }
    } catch { /* skip */ }

    let salesChannel: TextChannel;
    try {
      salesChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `📍 Personal sales channel — ${displayName}`,
        permissionOverwrites: permOverwrites
      }) as TextChannel;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create sales channel: ${err.message}` });
      return true;
    }

    // Make sure they're in the crew so the order panel works
    if (!profile) {
      try {
        const member = await guild.members.fetch(recruitId);
        const dn = member.displayName;
        await db.execute({
          sql: `INSERT OR IGNORE INTO profiles (discord_id, display_name, commission_rate, status) VALUES (?, ?, 0.3, 'offline')`,
          args: [recruitId, dn]
        });
        await db.execute({
          sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, 'mechanic')",
          args: [recruitId]
        });
      } catch { /* ignore */ }
    }

    const commRate = profile?.commission_rate ?? 0.3;
    await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [salesChannel.id, recruitId] });
    await postOrderPanel(salesChannel, recruitId, displayName, commRate);

    // Update the training channel button to show it's done
    try {
      const recent = await interaction.channel!.messages.fetch({ limit: 20 });
      const existing = [...recent.values()].find(m =>
        m.author.bot && m.components?.length > 0 &&
        m.components.some((row: any) => row.components?.some((c: any) => c.customId?.startsWith("training:createsaleschan:")))
      );
      if (existing) {
        const newRows = existing.components.map((row: any) => {
          const newRow = new ActionRowBuilder<ButtonBuilder>();
          for (const comp of row.components) {
            if (comp.customId?.startsWith("training:createsaleschan:")) {
              newRow.addComponents(
                new ButtonBuilder()
                  .setCustomId("training:saleschan:done")
                  .setLabel("✅ Sales Channel Created")
                  .setStyle(ButtonStyle.Success)
                  .setDisabled(true)
              );
            } else {
              newRow.addComponents(ButtonBuilder.from(comp));
            }
          }
          return newRow;
        });
        await existing.edit({ components: newRows });
      }
    } catch { /* ignore */ }

    await interaction.editReply({
      content: `✅ Sales channel created for <@${recruitId}> (**${displayName}**): <#${salesChannel.id}>\nOrder panel is pinned and ready.`
    });
    return true;
  }

  return false;
}

// ── Modal submit: training schedule form ───────────────────────────────────────
export async function handleTrainingModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const [ns, action] = interaction.customId.split(":");
  if (ns !== "training") return false;

  if (action === "modal") {
    const guild = interaction.guild!;
    await interaction.deferReply({ ephemeral: true });

    const yourName       = interaction.fields.getTextInputValue("your_name").trim();
    const timeAvailable  = interaction.fields.getTextInputValue("time_available").trim();
    const hasCityJobRaw  = interaction.fields.getTextInputValue("has_city_job").trim().toLowerCase();
    const hasSalesChanRaw= interaction.fields.getTextInputValue("has_sales_channel").trim().toLowerCase();

    const hasCityJob   = hasCityJobRaw.startsWith("y");
    const hasSalesChan = hasSalesChanRaw.startsWith("y");

    const config = await getGuildConfig(guild.id);

    // ── Change the recruit's server nickname to their in-city name ─────────────
    try {
      const member = await guild.members.fetch(interaction.user.id);
      await member.setNickname(yourName, "Training registration — in-city name set");
    } catch { /* bot may not have permission — silently skip */ }

    // ── Create temp training channel ──────────────────────────────────────────
    const safeName = yourName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 20);
    const channelName = `training-${safeName || "recruit"}`;

    const permOverwrites: any[] = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels
        ]
      });
    }
    // The recruit can see it
    permOverwrites.push({
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    // Owners, managers, trainers can see it
    for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
      permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    // Also add individual owners/trainers from DB
    try {
      const staffR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
      for (const row of staffR.rows) {
        const sid = String(row[0] ?? "");
        if (!sid || sid === interaction.user.id) continue;
        try {
          await guild.members.fetch(sid);
          permOverwrites.push({ id: sid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        } catch { /* not in server */ }
      }
    } catch { /* skip */ }

    let trainingChannel: TextChannel;
    try {
      trainingChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `📚 Training session — ${yourName}`,
        permissionOverwrites: permOverwrites
      }) as TextChannel;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to create training channel: ${err.message}` });
      return true;
    }

    // ── Build the training info embed ─────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setTitle("📚  TRAINING SESSION REQUEST")
      .setColor(COLORS.submitted)
      .setDescription(
        `**${yourName}** has requested a training session.\n\n` +
        `<@${interaction.user.id}> — welcome! A trainer will be with you shortly.`
      )
      .addFields(
        { name: "👤 Recruit",         value: `<@${interaction.user.id}> — **${yourName}**`, inline: true },
        { name: "⏰ Available",        value: `**${timeAvailable}**`,                         inline: true },
        { name: "\u200b",             value: "\u200b",                                        inline: true },
        { name: "💼 City Job",         value: hasCityJob   ? "✅ Yes" : "❌ No",               inline: true },
        { name: "🏪 Sales Channel",    value: hasSalesChan ? "✅ Yes" : "❌ No",               inline: true },
        { name: "\u200b",             value: "\u200b",                                        inline: true },
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    // ── Build action rows ──────────────────────────────────────────────────────
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId("training:close")
        .setLabel("🔒  Close & Delete Channel")
        .setStyle(ButtonStyle.Danger)
    ];

    // If they don't have a sales channel, add a create button for trainers
    if (!hasSalesChan) {
      buttons.unshift(
        new ButtonBuilder()
          .setCustomId(`training:createsaleschan:${interaction.user.id}:${safeName || "recruit"}`)
          .setLabel("➕  Create Sales Channel")
          .setStyle(ButtonStyle.Success)
      );
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    // Discord max 5 per row — split into rows of 3
    for (let i = 0; i < buttons.length; i += 3) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 3)));
    }

    await trainingChannel.send({ embeds: [embed], components: rows });

    // ── Ping owners if missing items ──────────────────────────────────────────
    const missingItems: string[] = [];
    if (!hasCityJob)   missingItems.push("city job");
    if (!hasSalesChan) missingItems.push("sales channel");

    if (missingItems.length > 0) {
      const ownerMentions: string[] = [];
      if (config?.owner_role_id)   ownerMentions.push(`<@&${config.owner_role_id}>`);
      if (config?.manager_role_id) ownerMentions.push(`<@&${config.manager_role_id}>`);

      const needsMsg =
        `⚠️ **Heads up!** ${ownerMentions.join(" ")}\n\n` +
        `<@${interaction.user.id}> (**${yourName}**) needs to be set up with: **${missingItems.join(" and ")}** before training can proceed.\n\n` +
        (hasSalesChan ? "" : `Use the **➕ Create Sales Channel** button above to create their channel right now.\n\n`) +
        `Please get that sorted before or during this session.`;

      await trainingChannel.send({ content: needsMsg });
    }

    // ── Trainer ping ──────────────────────────────────────────────────────────
    if (config?.trainer_role_id) {
      await trainingChannel.send({
        content: `<@&${config.trainer_role_id}> — a new recruit is ready for training! Check the details above. 📚`
      });
    }

    await interaction.editReply({
      content: `✅ Training channel created! Head to <#${trainingChannel.id}> — a trainer will meet you there.`
    });
    return true;
  }

  return false;
}

// ── Post training panel to a channel ──────────────────────────────────────────
export async function postTrainingPanel(channel: TextChannel) {
  const embed = new EmbedBuilder()
    .setTitle("📚  TRAINING SESSIONS  ·  TOKYO DRIFT CUSTOMS")
    .setColor(COLORS.submitted)
    .setDescription(
      "**Welcome to Tokyo Drift Customs!**\n\n" +
      "New recruit? Use the button below to schedule your training session.\n" +
      "A private channel will be created for you and your trainer.\n\n" +
      "**What you'll need before training:**\n" +
      "• A city job (for income)\n" +
      "• A sales channel (set up by management)\n\n" +
      "*If you're missing either of these, don't worry — your trainer can set up your sales channel right in the training channel.*"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("training:schedule")
      .setLabel("📋  Schedule Training")
      .setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
