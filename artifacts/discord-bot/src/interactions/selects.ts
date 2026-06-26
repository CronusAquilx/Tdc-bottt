import {
  AnySelectMenuInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder, UserSelectMenuBuilder, EmbedBuilder,
  ChannelType, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db, getProfile, getSetting, setSetting, rowToOrder, setGuildRoleMapping, getGuildConfig, splitRoleIds } from "../db.js";
import { buildDraftEmbed, money, COLORS } from "../lib/embeds.js";
import { requireRole } from "../lib/roles.js";
import { postOrderPanel } from "./orderpanel.js";
import { mainDraftButtonRows, categoryViewButtonRow, getCommissionData } from "./draftbuttons.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function handleSelect(interaction: AnySelectMenuInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── Role select menus ─────────────────────────────────────────────────────
  if (interaction.isRoleSelectMenu()) {
    // setup:setrole:level
    if (ns === "setup" && action === "setrole") {
      const level = rest[0] as "owner" | "manager" | "trainer" | "mechanic" | "needs_training";
      const validLevels = ["owner", "manager", "trainer", "mechanic", "needs_training"];
      if (!validLevels.includes(level)) { await interaction.reply({ content: "❌ Invalid role level.", ephemeral: true }); return; }
      const roleIds = interaction.values;
      if (!interaction.guild) { await interaction.reply({ content: "❌ Must be used in a server.", ephemeral: true }); return; }
      await setGuildRoleMapping(interaction.guild.id, level, roleIds);
      const levelLabel = level.charAt(0).toUpperCase() + level.slice(1).replace(/_/g, " ");
      const mentions = roleIds.map(id => `<@&${id}>`).join(", ");
      await interaction.reply({ content: `✅ **${levelLabel}** set to ${mentions}. Members with ${roleIds.length > 1 ? "any of these roles" : "this role"} can use ${level}-level commands.`, ephemeral: true });
    }

    // admin:assignbyrole:pickrole — pick role → fetch members with that role → show multi-select
    if (ns === "admin" && action === "assignbyrole" && rest[0] === "pickrole") {
      if (!(await requireRole(interaction, "manager"))) return;
      const guild = interaction.guild;
      if (!guild) { await interaction.reply({ content: "❌ Must be used in a server.", ephemeral: true }); return; }
      await interaction.deferUpdate();

      const roleId = interaction.values[0];
      let members: { id: string; displayName: string }[] = [];
      try {
        await guild.members.fetch();
        const role = await guild.roles.fetch(roleId);
        if (role) {
          members = [...role.members.values()].map(m => ({ id: m.id, displayName: m.displayName }));
        }
      } catch { /* ignore */ }

      if (!members.length) {
        await interaction.editReply({ content: `❌ No members found with that role.`, embeds: [], components: [] });
        return;
      }

      const limited = members.slice(0, 25);
      const embed = new EmbedBuilder()
        .setTitle("🔩  Assign by Role — Step 2")
        .setColor(COLORS.dark)
        .setDescription(
          `Found **${members.length}** member(s) with that role.\n` +
          (members.length > 25 ? "*(Showing first 25)*\n" : "") +
          "\nSelect which mechanics you want to assign to a manager.\nYou can select multiple."
        )
        .setFooter({ text: FOOTER });

      const memberSelect = new StringSelectMenuBuilder()
        .setCustomId("admin:assignbyrole:pickmembers")
        .setPlaceholder("Select mechanics to assign...")
        .setMinValues(1)
        .setMaxValues(Math.min(limited.length, 25))
        .addOptions(limited.map(m =>
          new StringSelectMenuOptionBuilder().setLabel(m.displayName.slice(0, 100)).setValue(m.id)
        ));

      await interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(memberSelect)]
      });
    }

    return;
  }

  // ── User select menus ──────────────────────────────────────────────────────
  if (interaction.isUserSelectMenu()) {
    // admin:setrole:pickmember:(trainer|manager) — assign user a role in the DB
    if (ns === "admin" && action === "setrole" && rest[0] === "pickmember") {
      if (!(await requireRole(interaction, "manager"))) return;
      await interaction.deferUpdate();
      try {
        const roleTarget = rest[1] as "trainer" | "manager";
        const targetUserId = interaction.values[0];
        const targetUser = interaction.users?.get(targetUserId) ?? (await interaction.client.users.fetch(targetUserId).catch(() => null));
        const displayName = targetUser?.displayName ?? targetUser?.username ?? targetUserId;
        // Ensure profile exists so the role record has a backing profile
        await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name, commission_rate) VALUES (?, ?, 0.3)", args: [targetUserId, displayName] });
        // Remove any existing role for this user then insert the new one
        await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [targetUserId] });
        await db.execute({ sql: "INSERT INTO user_roles (discord_id, role) VALUES (?, ?)", args: [targetUserId, roleTarget] });
        const embed = new EmbedBuilder()
          .setTitle(`✅ ${roleTarget === "trainer" ? "📚 Trainer" : "👔 Manager"} Assigned`)
          .setColor(COLORS.approved)
          .setDescription(
            `<@${targetUserId}> is now recognised as a **${roleTarget}** in the bot.\n\n` +
            `They will see their crew cut on their order embeds, and their commission is calculated accordingly.`
          )
          .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
        await interaction.editReply({ embeds: [embed], components: [] });
      } catch (err: any) {
        console.error("[TDC] setrole:pickmember error:", err);
        try { await interaction.editReply({ content: `❌ Failed to assign role: ${err?.message ?? "Unknown error"}`, components: [] }); } catch { /* ignore */ }
      }
      return;
    }

    // admin:assignbyrole:pickmanager — after bulk mechanic selection, pick manager
    if (ns === "admin" && action === "assignbyrole" && rest[0] === "pickmanager") {
      if (!(await requireRole(interaction, "manager"))) return;
      await interaction.deferUpdate();
      const managerId = interaction.values[0];
      const managerProfile = await getProfile(managerId);
      if (!managerProfile) {
        await interaction.editReply({ content: "❌ Manager not found — add them via `/crew add` first.", embeds: [], components: [] });
        return;
      }
      const pendingKey = `pending_bulk_assign_${interaction.user.id}`;
      const pendingStr = await getSetting(pendingKey);
      if (!pendingStr) {
        await interaction.editReply({ content: "❌ Session expired. Please start over.", embeds: [], components: [] });
        return;
      }
      const mechIds = pendingStr.split(",").filter(Boolean);
      let assigned = 0;
      const failedNames: string[] = [];
      for (const mechId of mechIds) {
        const mechProfile = await getProfile(mechId);
        if (!mechProfile) { failedNames.push(`<@${mechId}>`); continue; }
        await db.execute({ sql: "UPDATE profiles SET manager_id = ? WHERE discord_id = ?", args: [managerId, mechId] });
        assigned++;
      }
      await db.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: [pendingKey] });
      const embed = new EmbedBuilder()
        .setTitle("✅  Bulk Manager Assignment Complete")
        .setColor(COLORS.approved)
        .setDescription(
          `**${assigned}** mechanic(s) are now assigned to **${managerProfile.display_name}**.\n` +
          `💰 ${managerProfile.display_name} will earn **${Math.round((managerProfile.manager_override_rate ?? 0.20) * 100)}%** of each mechanic's commission per order.\n\n` +
          (failedNames.length ? `⚠️ Not found in crew (use \`/crew add\` first): ${failedNames.join(", ")}` : "")
        )
        .setFooter({ text: FOOTER });
      await interaction.editReply({ embeds: [embed], components: [] });
      return;
    }

    if (ns === "admin" && action === "saleschan" && rest[0] === "pickmechanic") {
      const type = rest[1];
      if (!(await requireRole(interaction, "manager"))) return;

      const mechanicId = interaction.values[0];
      const guild = interaction.guild!;

      if (type === "new") {
        await interaction.deferUpdate();

        const profile = await getProfile(mechanicId);
        if (!profile) {
          await interaction.editReply({ content: "❌ That user isn't in the crew. Add them via `/crew add` first.", components: [] });
          return;
        }

        // Ask which category to put the channel in
        const embed = new EmbedBuilder()
          .setTitle("📁  Choose a Category (optional)")
          .setColor(COLORS.primary)
          .setDescription(
            `Creating sales channel for **${profile.display_name}**.\n\n` +
            `Pick a **channel category** to place it in, or click **No Category** to create it at the top level.`
          )
          .setFooter({ text: FOOTER });

        const catRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`admin:saleschan:pickcat:${mechanicId}`)
            .setChannelTypes(ChannelType.GuildCategory)
            .setPlaceholder("Select a category folder...")
            .setMinValues(1).setMaxValues(1)
        );
        const skipRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`admin:saleschan:create:${mechanicId}`)
            .setLabel("⬆️ No Category — Create Now")
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply({ embeds: [embed], components: [catRow, skipRow] });

      } else {
        const profile = await getProfile(mechanicId);
        const displayName = profile?.display_name ?? `<@${mechanicId}>`;

        const embed = new EmbedBuilder()
          .setTitle("🔗  Attach Existing Sales Channel")
          .setColor(COLORS.primary)
          .setDescription(`**Step 2 of 2 — Pick the channel** to attach to **${displayName}**.`)
          .setFooter({ text: FOOTER });

        const chanRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`admin:saleschan:pickchan:${mechanicId}`)
            .setChannelTypes(ChannelType.GuildText)
            .setPlaceholder("Select the text channel to attach...")
            .setMinValues(1).setMaxValues(1)
        );

        await interaction.update({ embeds: [embed], components: [chanRow] });
      }
    }

    // ── Admin: commission pick mechanic ─────────────────────────────────────
    if (ns === "admin" && action === "commission" && rest[0] === "pickmechanic") {
      if (!(await requireRole(interaction, "manager"))) return;
      const mechanicId = interaction.values[0];
      const profile = await getProfile(mechanicId);
      if (!profile) {
        await interaction.update({ content: "❌ That user isn't in the crew.", embeds: [], components: [] });
        return;
      }

      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = await import("discord.js");
      const modal = new ModalBuilder()
        .setCustomId(`admin:commission:set:${mechanicId}`)
        .setTitle(`Set Commission — ${profile.display_name}`);
      modal.addComponents(
        new AR<InstanceType<typeof TextInputBuilder>>().addComponents(
          new TextInputBuilder()
            .setCustomId("rate")
            .setLabel("Commission rate (0–100, e.g. 30 = 30%)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(Math.round(profile.commission_rate * 100)))
            .setPlaceholder("Enter percentage, e.g. 30")
        )
      );
      await interaction.showModal(modal);
    }

    // ── Admin: pick manager to set override rate → open modal ────────────────
    if (ns === "admin" && action === "commission" && rest[0] === "pickmanageroverride") {
      if (!(await requireRole(interaction, "manager"))) return;
      const managerId = interaction.values[0];
      const profile = await getProfile(managerId);
      if (!profile) {
        await interaction.update({ content: "❌ That user isn't in the crew.", embeds: [], components: [] });
        return;
      }
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: AR } = await import("discord.js");
      const modal = new ModalBuilder()
        .setCustomId(`admin:commission:setoverride:${managerId}`)
        .setTitle(`Manager Override Cut — ${profile.display_name}`);
      modal.addComponents(
        new AR<InstanceType<typeof TextInputBuilder>>().addComponents(
          new TextInputBuilder()
            .setCustomId("override_rate")
            .setLabel("Override cut % (0–100, e.g. 20 = 20%)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(Math.round((profile.manager_override_rate ?? 0.20) * 100)))
            .setPlaceholder("Enter percentage, e.g. 20")
        )
      );
      await interaction.showModal(modal);
    }

    // ── Admin: assign manager — step 1, picked mechanic → pick manager ────────
    if (ns === "admin" && action === "assign" && rest[0] === "pickmechanic") {
      if (!(await requireRole(interaction, "manager"))) return;
      const mechanicId = interaction.values[0];
      const profile = await getProfile(mechanicId);
      if (!profile) {
        await interaction.update({ content: "❌ That user isn't in the crew.", embeds: [], components: [] });
        return;
      }
      const { UserSelectMenuBuilder: USM } = await import("discord.js");
      const embed = new EmbedBuilder()
        .setTitle("👤  Assign Manager — Step 2 of 2")
        .setColor(COLORS.primary)
        .setDescription(`Now pick the **manager** for **${profile.display_name}**.\nThe manager will earn **20% of this mechanic's commission** on each order.`)
        .setFooter({ text: FOOTER });
      const sel = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new USM()
          .setCustomId(`admin:assign:pickmanager:${mechanicId}`)
          .setPlaceholder("Pick a manager...")
          .setMinValues(1).setMaxValues(1)
      );
      await interaction.update({ embeds: [embed], components: [sel] });
    }

    // ── Admin: assign manager — step 2, picked manager → save ────────────────
    if (ns === "admin" && action === "assign" && rest[0] === "pickmanager") {
      if (!(await requireRole(interaction, "manager"))) return;
      const mechanicId = rest[1];
      const managerId  = interaction.values[0];
      const [mechanicProfile, managerProfile] = await Promise.all([
        getProfile(mechanicId), getProfile(managerId)
      ]);
      if (!mechanicProfile) {
        await interaction.update({ content: "❌ Mechanic not found.", embeds: [], components: [] });
        return;
      }
      if (!managerProfile) {
        await interaction.update({ content: "❌ Manager not found — they need to be added via `/crew add` first.", embeds: [], components: [] });
        return;
      }
      await db.execute({ sql: "UPDATE profiles SET manager_id = ? WHERE discord_id = ?", args: [managerId, mechanicId] });
      await interaction.update({
        content: `✅ **${mechanicProfile.display_name}** is now assigned to manager **${managerProfile.display_name}**.\n💰 ${managerProfile.display_name} will earn 20% of ${mechanicProfile.display_name}'s commission on each order.`,
        embeds: [], components: []
      });
    }

    return;
  }

  // ── Channel select menus ───────────────────────────────────────────────────
  if (interaction.isChannelSelectMenu()) {
    // ── Attach existing channel as sales channel ──────────────────────────────
    if (ns === "admin" && action === "saleschan" && rest[0] === "pickchan") {
      if (!(await requireRole(interaction, "manager"))) return;
      const mechanicId = rest[1];
      const channelId  = interaction.values[0];
      const guild = interaction.guild!;

      await interaction.deferUpdate();

      const profile = await getProfile(mechanicId);
      if (!profile) {
        await interaction.editReply({ content: "❌ Mechanic not found. Add them via `/crew add` first.", components: [] });
        return;
      }

      let ch: any;
      try {
        ch = await guild.channels.fetch(channelId);
        if (!ch?.isTextBased()) throw new Error("Not a text channel");
      } catch {
        await interaction.editReply({ content: "❌ Channel not found or not a text channel.", components: [] });
        return;
      }

      await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channelId, mechanicId] });

      let panelPosted = true;
      try {
        await postOrderPanel(ch as TextChannel, mechanicId, profile.display_name, profile.commission_rate);
      } catch {
        panelPosted = false;
      }

      await interaction.editReply({
        content: panelPosted
          ? `✅ <#${channelId}> attached as **${profile.display_name}**'s sales channel. Order panel posted.`
          : `✅ <#${channelId}> attached as **${profile.display_name}**'s sales channel.\n⚠️ Could not post the order panel — make sure the bot has **Send Messages** and **Embed Links** permission in that channel, then run the setup again.`,
        embeds: [], components: []
      });
    }

    // ── Category picker for new sales channel ─────────────────────────────────
    // customId: admin:saleschan:pickcat:{mechanicId}
    if (ns === "admin" && action === "saleschan" && rest[0] === "pickcat") {
      if (!(await requireRole(interaction, "manager"))) return;
      const mechanicId = rest[1];
      const categoryId = interaction.values[0];
      const guild = interaction.guild!;

      await interaction.deferUpdate();

      const profile = await getProfile(mechanicId);
      if (!profile) {
        await interaction.editReply({ content: "❌ Mechanic not found. Add them via `/crew add` first.", components: [], embeds: [] });
        return;
      }

      // Create the sales channel inside the selected category
      const { PermissionFlagsBits, ChannelType } = await import("discord.js");
      const { splitRoleIds: srid, getGuildConfig: ggc } = await import("../db.js");
      const config = await ggc(guild.id);
      const channelName = `sales-${profile.display_name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30)}`;

      const permOverwrites: any[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      ];
      if (guild.members.me) {
        permOverwrites.push({ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
      }
      permOverwrites.push({ id: mechanicId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      for (const rid of [...srid(config?.owner_role_id), ...srid(config?.manager_role_id), ...srid(config?.trainer_role_id)]) {
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
          parent: categoryId,
          topic: `📍 Personal sales channel — ${profile.display_name}`,
          permissionOverwrites: permOverwrites
        }) as TextChannel;
      } catch (err: any) {
        await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}`, embeds: [], components: [] });
        return;
      }

      await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, mechanicId] });
      await postOrderPanel(channel, mechanicId, profile.display_name, profile.commission_rate);

      await interaction.editReply({
        content: `✅ Sales channel created for **${profile.display_name}** in the selected category: <#${channel.id}>\nThe order panel has been pinned.`,
        embeds: [], components: []
      });
    }

    return;
  }

  if (!interaction.isStringSelectMenu()) return;

  // ── Bulk assign by role: mechanic multi-select → pick manager ─────────────
  if (ns === "admin" && action === "assignbyrole" && rest[0] === "pickmembers") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferUpdate();
    const selectedIds = interaction.values;
    const pendingKey = `pending_bulk_assign_${interaction.user.id}`;
    await setSetting(pendingKey, selectedIds.join(","));

    const names = (await Promise.all(selectedIds.map(id => getProfile(id))))
      .map((p, i) => p?.display_name ?? `<@${selectedIds[i]}>`)
      .join(", ");

    const embed = new EmbedBuilder()
      .setTitle("🔩  Assign by Role — Step 3")
      .setColor(COLORS.dark)
      .setDescription(
        `**${selectedIds.length}** mechanic(s) selected:\n${names}\n\n` +
        "Now pick the **manager** to assign them all to."
      )
      .setFooter({ text: FOOTER });

    const managerSelect = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("admin:assignbyrole:pickmanager")
        .setPlaceholder("Pick a manager...")
        .setMinValues(1).setMaxValues(1)
    );
    await interaction.editReply({ embeds: [embed], components: [managerSelect] });
    return;
  }

  // ── Remove item from order ─────────────────────────────────────────────────
  if (ns === "order" && action === "removeitem") {
    await interaction.deferUpdate();
    const orderId = extra;
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const currentItems: any[] = order.items ?? [];

    const indicesToRemove = new Set(interaction.values.map(v => parseInt(v, 10)));
    const removed   = currentItems.filter((_: any, idx: number) => indicesToRemove.has(idx));
    const remaining = currentItems.filter((_: any, idx: number) => !indicesToRemove.has(idx));

    // Use delta approach so any manual labour adjustment is preserved
    const removedPartsCost = removed.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const removedLabour    = removed.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newPartsCost = Math.max(0, order.parts_cost - removedPartsCost);
    const newLabour    = Math.max(0, order.labour    - removedLabour);
    const newTotal     = newPartsCost + newLabour;

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(remaining), newPartsCost, newLabour, newTotal, orderId]
    });

    const updatedR = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    const updated = rowToOrder(updatedR.rows[0]);
    const guildId = interaction.guildId ?? "";
    const commData = await getCommissionData(interaction.user.id, guildId, updated.role_level);
    const crewCutInfo = ["trainer","manager","owner"].includes(updated.role_level)
      ? { amount: commData.crewCut, rate: commData.crewCutRate, label: commData.crewCutLabel }
      : undefined;

    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(c => new StringSelectMenuOptionBuilder().setLabel(c).setValue(c)));

    await interaction.editReply({
      content: `✅ Removed ${indicesToRemove.size} item(s) from the order.`,
      embeds: [buildDraftEmbed(updated, commData.weekCommission, commData.rate, crewCutInfo)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return;
  }

  // ── Select category → show items ───────────────────────────────────────────
  if (ns === "order" && action === "selectcategory") {
    await interaction.deferUpdate();
    const category = interaction.values[0];
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const items: { label: string; category: string; price: number; cost: number; labour: number }[] = catalog.items ?? [];
    const catItems = items.filter(i => i.category === category);
    if (!catItems.length) { await interaction.followUp({ content: `No items in **${category}**.`, ephemeral: true }); return; }

    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [extra] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const guildId2 = interaction.guildId ?? "";
    const commData2 = await getCommissionData(interaction.user.id, guildId2, order.role_level);
    const crewCutInfo2 = ["trainer","manager","owner"].includes(order.role_level)
      ? { amount: commData2.crewCut, rate: commData2.crewCutRate, label: commData2.crewCutLabel }
      : undefined;

    // Mark already-added items so user can see what's on the order
    const existingLabels = new Set((order.items ?? []).map((i: any) => `${i.category}::${i.label}`));

    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectitem:${extra}:${category}`)
      .setPlaceholder(`Select from ${category}...`)
      .setMinValues(1)
      .setMaxValues(Math.min(catItems.length, 10))
      .addOptions(catItems.map(i => {
        const alreadyAdded = existingLabels.has(`${i.category}::${i.label}`);
        return new StringSelectMenuOptionBuilder()
          .setLabel(alreadyAdded ? `✓ ${i.label}` : i.label)
          .setValue(i.label)
          .setDescription(`Parts: ${money(i.cost)} | Labour: ${money(i.labour)} | Total: ${money(i.price)}${alreadyAdded ? " · already added" : ""}`);
      }));

    const embed = buildDraftEmbed(order, commData2.weekCommission, commData2.rate, crewCutInfo2);
    embed.setTitle(`📝  DRAFT  ·  ${order.order_number}  ·  ${category}`);

    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect),
        categoryViewButtonRow(extra)
      ]
    });
    return;
  }

  // ── Select specific items ──────────────────────────────────────────────────
  if (ns === "order" && action === "selectitem") {
    await interaction.deferUpdate();
    const orderId = extra.split(":")[0];
    const category = extra.split(":").slice(1).join(":");
    const catalogStr = await getSetting("parts_catalog");
    const catalog = JSON.parse(catalogStr ?? "{}");
    const allItems: { label: string; category: string; price: number; cost: number; labour: number }[] = catalog.items ?? [];
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    if (!r.rows[0]) return;
    const order = rowToOrder(r.rows[0]);
    const currentItems: any[] = order.items ?? [];

    const existingKeys = new Set(currentItems.map((i: any) => `${i.category}::${i.label}`));
    const newItems = interaction.values.map(label => {
      const found = allItems.find(i => i.label === label && i.category === category);
      if (!found) return null;
      const key = `${found.category}::${found.label}`;
      if (existingKeys.has(key)) return null;
      existingKeys.add(key);
      return { label: found.label, price: found.price, cost: found.cost, labour: found.labour, category: found.category };
    }).filter(Boolean);

    if (!newItems.length) {
      await interaction.followUp({ content: "⚠️ All selected items are already on this order. Use **🗑️ Remove** to remove them first.", ephemeral: true });
      return;
    }

    const merged = [...currentItems, ...newItems];
    // Use delta approach so any manual labour adjustment (from ✏️ Labour modal) is preserved
    const addedPartsCost = (newItems as any[]).reduce((s, i) => s + (i.cost ?? 0), 0);
    const addedLabour    = (newItems as any[]).reduce((s, i) => s + (i.labour ?? 0), 0);
    const newPartsCost = order.parts_cost + addedPartsCost;
    const newLabour    = order.labour + addedLabour;
    const newTotal     = newPartsCost + newLabour;

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(merged), newPartsCost, newLabour, newTotal, orderId]
    });

    const updatedR2 = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] });
    const updated = rowToOrder(updatedR2.rows[0]);
    const guildId3 = interaction.guildId ?? "";
    const commData3 = await getCommissionData(interaction.user.id, guildId3, updated.role_level);
    const crewCutInfo3 = ["trainer","manager","owner"].includes(updated.role_level)
      ? { amount: commData3.crewCut, rate: commData3.crewCutRate, label: commData3.crewCutLabel }
      : undefined;

    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    const addedNames = (newItems as any[]).map(i => i.label).join(", ");
    await interaction.editReply({
      content: `✅ Added: **${addedNames}**`,
      embeds: [buildDraftEmbed(updated, commData3.weekCommission, commData3.rate, crewCutInfo3)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        ...mainDraftButtonRows(orderId)
      ]
    });
    return;
  }
}
