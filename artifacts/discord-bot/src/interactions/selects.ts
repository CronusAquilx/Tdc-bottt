import {
  AnySelectMenuInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder, EmbedBuilder,
  ChannelType, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db, getProfile, getSetting, rowToOrder, setGuildRoleMapping, getGuildConfig } from "../db.js";
import { buildDraftEmbed, money, COLORS } from "../lib/embeds.js";
import { requireRole } from "../lib/roles.js";
import { postOrderPanel } from "./orderpanel.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function handleSelect(interaction: AnySelectMenuInteraction) {
  const [ns, action, ...rest] = interaction.customId.split(":");
  const extra = rest.join(":");

  // ── Role select menus (setup:setrole:level) ────────────────────────────────
  if (interaction.isRoleSelectMenu()) {
    if (ns === "setup" && action === "setrole") {
      const level = rest[0] as "owner" | "manager" | "trainer" | "mechanic" | "needs_training";
      const validLevels = ["owner", "manager", "trainer", "mechanic", "needs_training"];
      if (!validLevels.includes(level)) { await interaction.reply({ content: "❌ Invalid role level.", ephemeral: true }); return; }
      const roleId = interaction.values[0];
      if (!interaction.guild) { await interaction.reply({ content: "❌ Must be used in a server.", ephemeral: true }); return; }
      await setGuildRoleMapping(interaction.guild.id, level, roleId);
      const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
      await interaction.reply({ content: `✅ **${levelLabel}** mapped to <@&${roleId}>. Members with this role can now use ${level}-level commands.`, ephemeral: true });
    }
    return;
  }

  // ── User select menus ──────────────────────────────────────────────────────
  if (interaction.isUserSelectMenu()) {
    // admin:saleschan:pickmechanic:new  OR  admin:saleschan:pickmechanic:existing
    if (ns === "admin" && action === "saleschan" && rest[0] === "pickmechanic") {
      const type = rest[1]; // "new" | "existing"
      if (!(await requireRole(interaction, "manager"))) return;

      const mechanicId = interaction.values[0];
      const guild = interaction.guild!;

      if (type === "new") {
        // Immediately create the channel
        await interaction.deferUpdate();

        const profile = await getProfile(mechanicId);
        if (!profile) {
          await interaction.editReply({ content: "❌ That user isn't in the crew. Add them via `/crew add` first.", components: [] });
          return;
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
        for (const rid of [config?.owner_role_id, config?.manager_role_id, config?.trainer_role_id].filter(Boolean)) {
          permOverwrites.push({ id: rid!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        }
        const managersR = await db.execute("SELECT discord_id FROM user_roles WHERE role IN ('owner', 'manager', 'trainer')");
        for (const row of managersR.rows) {
          const mid = String(row[0]);
          if (!mid || mid === mechanicId) continue;
          try {
            await guild.members.fetch(mid);
            permOverwrites.push({ id: mid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          } catch { /* not in server */ }
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
          await interaction.editReply({ content: `❌ Failed to create channel: ${err.message}`, components: [] });
          return;
        }

        await db.execute({ sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?", args: [channel.id, mechanicId] });
        await postOrderPanel(channel, mechanicId, profile.display_name, profile.commission_rate);

        await interaction.editReply({
          content: `✅ Sales channel created for <@${mechanicId}> (**${profile.display_name}**): <#${channel.id}>\nOrder panel pinned and ready.`,
          embeds: [], components: []
        });

      } else {
        // "existing" — step 2: ask which channel to attach
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
    return;
  }

  // ── Channel select menus ───────────────────────────────────────────────────
  if (interaction.isChannelSelectMenu()) {
    // admin:saleschan:pickchan:{mechanicId}
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
    return;
  }

  if (!interaction.isStringSelectMenu()) return;

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
    const allTimeTotalR = await db.execute({
      sql: "SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete'",
      args: [interaction.user.id]
    });
    const allTimeTotal = Number(allTimeTotalR.rows[0]?.[0] ?? 0);

    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectitem:${extra}:${category}`)
      .setPlaceholder(`Select from ${category}...`)
      .setMinValues(1)
      .setMaxValues(Math.min(catItems.length, 10))
      .addOptions(catItems.map(i =>
        new StringSelectMenuOptionBuilder()
          .setLabel(i.label)
          .setValue(i.label)
          .setDescription(`Parts: ${money(i.cost)} | Labour: ${money(i.labour)} | Total: ${money(i.price)}`)
      ));

    const embed = buildDraftEmbed(order, allTimeTotal);
    embed.setTitle(`📝  DRAFT  ·  ${order.order_number}  ·  ${category}`);

    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:backtocats:${extra}`).setLabel("← Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:editlabour:${extra}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${extra}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${extra}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
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
      await interaction.followUp({ content: "⚠️ All selected items are already on this order.", ephemeral: true });
    }

    const merged = [...currentItems, ...newItems];
    const newPartsCost = merged.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
    const newLabour    = merged.reduce((s: number, i: any) => s + (i.labour ?? 0), 0);
    const newTotal     = merged.reduce((s: number, i: any) => s + (i.price ?? 0), 0);

    await db.execute({
      sql: "UPDATE orders SET items = ?, parts_cost = ?, labour = ?, total = ? WHERE id = ?",
      args: [JSON.stringify(merged), newPartsCost, newLabour, newTotal, orderId]
    });

    const updated = rowToOrder((await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [orderId] })).rows[0]);
    const allTimeTotalR2 = await db.execute({
      sql: "SELECT COALESCE(SUM(total), 0) FROM orders WHERE mechanic_id = ? AND status = 'complete'",
      args: [interaction.user.id]
    });
    const allTimeTotal2 = Number(allTimeTotalR2.rows[0]?.[0] ?? 0);

    const categories: string[] = catalog.categories ?? [];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`order:selectcategory:${orderId}`)
      .setPlaceholder("Add more services...")
      .addOptions(categories.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat)));

    await interaction.editReply({
      embeds: [buildDraftEmbed(updated, allTimeTotal2)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`order:editlabour:${orderId}`).setLabel("✏️ Edit Labour").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`order:submit:${orderId}`).setLabel("✅ Complete Order").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`order:cancel:${orderId}`).setLabel("✕ Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
    return;
  }
}
