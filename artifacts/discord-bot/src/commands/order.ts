import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} from "discord.js";
import { db, getGuildConfig, getProfile, getUserRole, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, COLORS, money, statusEmoji } from "../lib/embeds.js";
import { randomUUID, paginate } from "../lib/utils.js";
import type { Order } from "../types.js";

export const data = new SlashCommandBuilder()
  .setName("order")
  .setDescription("Order management")
  .addSubcommand(s => s.setName("new").setDescription("Create a new order"))
  .addSubcommand(s =>
    s.setName("list")
      .setDescription("List orders")
      .addStringOption(o =>
        o.setName("status").setDescription("Filter by status")
          .addChoices(
            { name: "Draft", value: "draft" },
            { name: "Submitted", value: "submitted" },
            { name: "Approved", value: "approved" },
            { name: "Paid", value: "paid" },
            { name: "Rejected", value: "rejected" }
          )
      )
      .addIntegerOption(o => o.setName("page").setDescription("Page number").setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName("view")
      .setDescription("View an order")
      .addStringOption(o => o.setName("order_number").setDescription("e.g. TDC-0001").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("approve")
      .setDescription("Approve a submitted order (manager+)")
      .addStringOption(o => o.setName("order_number").setDescription("Order number").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("reject")
      .setDescription("Reject an order (manager+)")
      .addStringOption(o => o.setName("order_number").setDescription("Order number").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Rejection reason").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "new") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    const modal = new ModalBuilder().setCustomId("order:notes").setTitle("New Order — Notes");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Order Notes")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Customer requests, build details...")
      )
    );
    await interaction.showModal(modal);
    return;
  }

  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });
    const role = await getUserRole(interaction.user.id);
    const isManager = role === "owner" || role === "manager";
    const status = interaction.options.getString("status");
    const page = (interaction.options.getInteger("page") ?? 1) - 1;

    const r = isManager
      ? status
        ? await db.execute({ sql: "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC", args: [status] })
        : await db.execute("SELECT * FROM orders ORDER BY created_at DESC")
      : status
        ? await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = ? ORDER BY created_at DESC", args: [interaction.user.id, status] })
        : await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? ORDER BY created_at DESC", args: [interaction.user.id] });

    const rows = r.rows.map(rowToOrder);
    const { items, total, pages } = paginate(rows, page, 10);

    if (!items.length) { await interaction.editReply({ content: "No orders found." }); return; }

    const lines = await Promise.all(items.map(async o => {
      const p = await getProfile(o.mechanic_id);
      return `${statusEmoji(o.status)} **${o.order_number}** — ${p?.display_name ?? "Unknown"} — ${money(o.total)} — \`${o.status.toUpperCase()}\``;
    }));

    const embed = new EmbedBuilder()
      .setTitle(`📋 Orders${status ? ` · ${status.toUpperCase()}` : ""}`)
      .setColor(COLORS.primary)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Tokyo Drift Customs | Page ${page + 1} / ${pages} · ${total} total` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`order:list:${page - 1}:${status ?? ""}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`order:list:${page + 1}:${status ?? ""}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (sub === "view") {
    await interaction.deferReply({ ephemeral: true });
    const orderNum = interaction.options.getString("order_number", true).toUpperCase();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE order_number = ?", args: [orderNum] });
    if (!r.rows[0]) { await interaction.editReply({ content: `❌ Order **${orderNum}** not found.` }); return; }
    const order = rowToOrder(r.rows[0]);
    const role = await getUserRole(interaction.user.id);
    const isManager = role === "owner" || role === "manager";
    if (!isManager && order.mechanic_id !== interaction.user.id) { await interaction.editReply({ content: "❌ You can only view your own orders." }); return; }
    const mechanic = await getProfile(order.mechanic_id);
    const approver = order.approved_by ? await getProfile(order.approved_by) : null;
    const embed = buildOrderEmbed(order, mechanic?.display_name ?? "Unknown", approver?.display_name ?? undefined);
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (isManager && order.status === "submitted") {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`order:approve:${order.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`order:rejectprompt:${order.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      ));
    }
    await interaction.editReply({ embeds: [embed], components });
    return;
  }

  if (sub === "approve") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });
    const orderNum = interaction.options.getString("order_number", true).toUpperCase();
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE order_number = ?", args: [orderNum] });
    if (!r.rows[0]) { await interaction.editReply({ content: `❌ Order **${orderNum}** not found.` }); return; }
    const order = rowToOrder(r.rows[0]);
    if (order.status !== "submitted") { await interaction.editReply({ content: `❌ Order is **${order.status}** — only submitted orders can be approved.` }); return; }
    await db.execute({ sql: "UPDATE orders SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?", args: [interaction.user.id, order.id] });
    const ur = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [order.id] });
    const updated = rowToOrder(ur.rows[0]);
    const mechanic = await getProfile(order.mechanic_id);
    const approver = await getProfile(interaction.user.id);
    const embed = buildOrderEmbed(updated, mechanic?.display_name ?? "Unknown", approver?.display_name ?? "Unknown");
    if (order.discord_message_id && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.orders_channel_id) {
        try { const ch = await interaction.guild.channels.fetch(config.orders_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).messages.fetch(order.discord_message_id); await msg.edit({ embeds: [embed], components: [] }); } } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `✅ Order **${orderNum}** approved.`, embeds: [embed] });
    return;
  }

  if (sub === "reject") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });
    const orderNum = interaction.options.getString("order_number", true).toUpperCase();
    const reason = interaction.options.getString("reason", true);
    const r = await db.execute({ sql: "SELECT * FROM orders WHERE order_number = ?", args: [orderNum] });
    if (!r.rows[0]) { await interaction.editReply({ content: `❌ Order **${orderNum}** not found.` }); return; }
    const order = rowToOrder(r.rows[0]);
    if (!["submitted", "approved"].includes(order.status)) { await interaction.editReply({ content: `❌ Cannot reject order in **${order.status}** status.` }); return; }
    await db.execute({ sql: "UPDATE orders SET status = 'rejected', rejected_reason = ? WHERE id = ?", args: [reason, order.id] });
    const ur = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [order.id] });
    const updated = rowToOrder(ur.rows[0]);
    const mechanic = await getProfile(order.mechanic_id);
    const embed = buildOrderEmbed(updated, mechanic?.display_name ?? "Unknown");
    if (order.discord_message_id && interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.orders_channel_id) {
        try { const ch = await interaction.guild.channels.fetch(config.orders_channel_id); if (ch?.isTextBased()) { const msg = await (ch as any).messages.fetch(order.discord_message_id); await msg.edit({ embeds: [embed], components: [] }); } } catch { /* ignore */ }
      }
    }
    await interaction.editReply({ content: `❌ Order **${orderNum}** rejected.`, embeds: [embed] });
  }
}
