import {
  ButtonInteraction, ModalSubmitInteraction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ChannelType, PermissionFlagsBits,
  OverwriteType, TextChannel
} from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
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
    if (!(await requireRole(interaction, "trainer"))) return true;
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

    if (!(await requireRole(interaction, "trainer"))) return true;

    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild!;
    const config = await getGuildConfig(guild.id);

    // Get or build display name
    let displayName = safeName.replace(/-/g, " ");
    const profile = await getProfile(recruitId);
    if (profile) displayName = profile.display_name;

    const channelName = `sales-${safeName.slice(0, 30)}`;

    const permOverwrites: any[] = [
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      });
    }
    permOverwrites.push({
      id: recruitId,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    for (const rid of [
      ...splitRoleIds(config?.owner_role_id),
      ...splitRoleIds(config?.manager_role_id),
      ...splitRoleIds(config?.trainer_role_id)
    ]) {
      permOverwrites.push({ id: rid, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
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

    // ── Save in-city ID to their profile (upsert) ────────────────────────────
    await db.execute({
      sql: `INSERT INTO profiles (discord_id, display_name, in_city_id, status)
            VALUES (?, ?, ?, 'offline')
            ON CONFLICT(discord_id) DO UPDATE SET in_city_id = excluded.in_city_id`,
      args: [interaction.user.id, yourName, yourName]
    });

    // ── Change the recruit's server nickname to their in-city name ─────────────
    let nicknameSet = false;
    let nicknameError = "";
    try {
      const member = await guild.members.fetch(interaction.user.id);
      await member.setNickname(yourName, "Training registration — in-city name set");
      nicknameSet = true;
    } catch (err: any) {
      // Discord doesn't allow bots to rename the server owner
      if (err?.code === 50013 || String(err?.message).toLowerCase().includes("owner")) {
        nicknameError = "server owner";
      } else {
        nicknameError = "missing permissions";
      }
    }

    // ── Create temp training channel ──────────────────────────────────────────
    const safeName = yourName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 20);
    const channelName = `training-${safeName || "recruit"}`;

    const permOverwrites: any[] = [
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (guild.members.me) {
      permOverwrites.push({
        id: guild.members.me.id,
        type: OverwriteType.Member,
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
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    // Owners, managers, trainers can see it — use splitRoleIds to handle multi-role configs
    for (const rid of [
      ...splitRoleIds(config?.owner_role_id),
      ...splitRoleIds(config?.manager_role_id),
      ...splitRoleIds(config?.trainer_role_id)
    ]) {
      permOverwrites.push({ id: rid, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    // Also add individual trainer/manager/owner users from user_roles DB
    try {
      const staffRows = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner','manager','trainer')");
      for (const row of staffRows.rows) {
        const uid = String(row[0]);
        if (!uid || uid === interaction.user.id) continue;
        try {
          await guild.members.fetch(uid);
          permOverwrites.push({ id: uid, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        } catch { /* not in server */ }
      }
    } catch { /* ignore */ }
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

    // ── Nickname feedback ─────────────────────────────────────────────────────
    if (nicknameSet) {
      await trainingChannel.send({
        content: `✅ <@${interaction.user.id}>'s server nickname has been updated to **${yourName}**.`
      });
    } else if (nicknameError === "server owner") {
      await trainingChannel.send({
        content: `⚠️ <@${interaction.user.id}> — I couldn't update your server nickname automatically (Discord doesn't allow bots to rename server owners). Please change your nickname to **${yourName}** manually.\n> *Right-click yourself → Edit Server Profile → Nickname*`
      });
    } else if (nicknameError) {
      await trainingChannel.send({
        content: `⚠️ <@${interaction.user.id}> — I couldn't update your server nickname automatically (missing permissions). Please ask a manager to set your nickname to **${yourName}**, or change it yourself.\n> *Right-click yourself → Edit Server Profile → Nickname*`
      });
    }

    // ── Build owner/manager mention lists (roles + individual DB users) ──────────
    const ownerRoleMentions = [
      ...splitRoleIds(config?.owner_role_id).map(r => `<@&${r}>`),
    ];
    const managerRoleMentions = [
      ...splitRoleIds(config?.manager_role_id).map(r => `<@&${r}>`),
    ];
    // Also ping individual owners/managers from DB (in case Discord roles aren't configured)
    const ownerUserMentions: string[] = [];
    const managerUserMentions: string[] = [];
    try {
      const staffRows = await db.execute("SELECT discord_id, role FROM user_roles WHERE role IN ('owner','manager')");
      for (const row of staffRows.rows) {
        const uid = String(row[0]);
        const role = String(row[1]);
        if (!uid || uid === interaction.user.id) continue;
        if (role === "owner") ownerUserMentions.push(`<@${uid}>`);
        else if (role === "manager") managerUserMentions.push(`<@${uid}>`);
      }
    } catch { /* ignore */ }

    const allOwnerMentions = [...new Set([...ownerRoleMentions, ...ownerUserMentions])];
    const allManagerMentions = [...new Set([...managerRoleMentions, ...managerUserMentions])];
    const allStaffMentions = [...new Set([...allOwnerMentions, ...allManagerMentions])];

    // ── Ping owners if recruit is missing city job ────────────────────────────
    if (!hasCityJob) {
      const missingThings = [
        ...(!hasCityJob ? ["city job / in-city ID"] : []),
        ...(!hasSalesChan ? ["sales channel"] : [])
      ];
      const pingTargets = allOwnerMentions.length ? allOwnerMentions : allStaffMentions;
      if (pingTargets.length) {
        await trainingChannel.send({
          content:
            `⚠️ **Heads up!** ${pingTargets.join(" ")}\n\n` +
            `<@${interaction.user.id}> (**${yourName}**) needs: **${missingThings.join(" and ")}** before training can proceed.\n\n` +
            (!hasSalesChan ? `Use the **➕ Create Sales Channel** button above to create their channel right now.\n\n` : "") +
            `Please sort this before or during the session.`
        });
      }
    } else if (!hasSalesChan) {
      if (allStaffMentions.length) {
        await trainingChannel.send({
          content:
            `⚠️ **Heads up!** ${allStaffMentions.join(" ")}\n\n` +
            `<@${interaction.user.id}> (**${yourName}**) still needs a **sales channel**.\n` +
            `Use the **➕ Create Sales Channel** button above to create it now.`
        });
      }
    }

    // ── Trainer ping in the ticket ─────────────────────────────────────────────
    const trainerRoleMentions = splitRoleIds(config?.trainer_role_id).map(r => `<@&${r}>`);
    const trainerUserMentions: string[] = [];
    try {
      const trainerRows = await db.execute("SELECT discord_id FROM user_roles WHERE role = 'trainer'");
      for (const row of trainerRows.rows) {
        const uid = String(row[0]);
        if (uid && uid !== interaction.user.id) trainerUserMentions.push(`<@${uid}>`);
      }
    } catch { /* ignore */ }
    const allTrainerMentions = [...new Set([...trainerRoleMentions, ...trainerUserMentions])];

    if (allTrainerMentions.length) {
      await trainingChannel.send({
        content: `${allTrainerMentions.join(" ")} — a new recruit is ready for training! Check the details above. 📚`
      });
    }

    // ── Also ping trainers in the general training channel ────────────────────
    if (config?.training_channel_id && allTrainerMentions.length) {
      try {
        const trainingCh = await guild.channels.fetch(config.training_channel_id);
        if (trainingCh?.isTextBased()) {
          await (trainingCh as any).send({
            content:
              `${allTrainerMentions.join(" ")} 📚 **New training request!**\n` +
              `**${yourName}** (<@${interaction.user.id}>) has opened a training ticket → <#${trainingChannel.id}>`
          });
        }
      } catch { /* ignore if channel missing */ }
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
