import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";
import { db, getProfile, getUserRole, rowToOrder } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildOrderEmbed, COLORS, money, statusEmoji } from "../lib/embeds.js";
import { paginate } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("order")
  .setDescription("Order management")
  .addSubcommand(s => s.setName("new").setDescription("Create a new order in your sales channel"))
  .addSubcommand(s =>
    s.setName("list")
      .setDescription("List orders")
      .addStringOption(o =>
        o.setName("status").setDescription("Filter by status")
          .addChoices(
            { name: "Draft", value: "draft" },
            { name: "Complete", value: "complete" },
            { name: "Paid", value: "paid" }
          )
      )
      .addIntegerOption(o => o.setName("page").setDescription("Page number").setMinValue(1))
  )
  .addSubcommand(s =>
    s.setName("view")
      .setDescription("View an order")
      .addStringOption(o => o.setName("order_number").setDescription("e.g. TDC-0001").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "new") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    const modal = new ModalBuilder().setCustomId("order:notes").setTitle("New Order");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Customer Notes (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Customer name, vehicle, special requests...")
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
        : await db.execute("SELECT * FROM orders WHERE status != 'draft' ORDER BY created_at DESC")
      : status
        ? await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status = ? ORDER BY created_at DESC", args: [interaction.user.id, status] })
        : await db.execute({ sql: "SELECT * FROM orders WHERE mechanic_id = ? AND status != 'draft' ORDER BY created_at DESC", args: [interaction.user.id] });

    const rows = r.rows.map(rowToOrder);
    const { items, total, pages } = paginate(rows, page, 10);

    if (!items.length) { await interaction.editReply({ content: "No orders found." }); return; }

    const lines = await Promise.all(items.map(async o => {
      const p = await getProfile(o.mechanic_id);
      const commRate = p?.commission_rate ?? 0.3;
      const commission = o.labour * commRate;
      return `${statusEmoji(o.status)} **${o.order_number}** — ${p?.display_name ?? "?"} — ${money(o.total)} — Cut: ${money(commission)} — \`${o.status.toUpperCase()}\``;
    }));

    const embed = new EmbedBuilder()
      .setTitle(`🏁  Orders${status ? ` · ${status.toUpperCase()}` : ""}`)
      .setColor(COLORS.primary)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `東京ドリフトカスタム  ·  Page ${page + 1} / ${pages} · ${total} total` })
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
    if (!isManager && order.mechanic_id !== interaction.user.id) {
      await interaction.editReply({ content: "❌ You can only view your own orders." });
      return;
    }
    const mechanic = await getProfile(order.mechanic_id);
    const embed = buildOrderEmbed(order, mechanic?.display_name ?? "Unknown", 0, mechanic?.commission_rate ?? 0.3);
    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
