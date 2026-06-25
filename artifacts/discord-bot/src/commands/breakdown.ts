import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money, statusEmoji } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("breakdown")
  .setDescription("View mechanic performance breakdown (manager+)")
  .addUserOption(o => o.setName("mechanic").setDescription("Specific mechanic (leave empty for all)"));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser("mechanic");
  const ws = weekStart();

  let mechanicRows: any[][];
  if (targetUser) {
    const p = await getProfile(targetUser.id);
    if (!p) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }
    mechanicRows = [[p.discord_id, p.display_name, p.commission_rate, p.hours_worked_this_week, p.status]];
  } else {
    const r = await db.execute(
      `SELECT p.discord_id, p.display_name, p.commission_rate, p.hours_worked_this_week, p.status
       FROM user_roles ur JOIN profiles p ON p.discord_id = ur.discord_id WHERE ur.role = 'mechanic' ORDER BY p.display_name`
    );
    mechanicRows = r.rows as unknown as any[][];
  }

  const embeds: EmbedBuilder[] = [];
  const buttons: ButtonBuilder[] = [];

  for (const row of mechanicRows) {
    const [discordId, displayName, commRate, hoursWeek, status] = [String(row[0]), String(row[1]), Number(row[2] ?? 0.3), Number(row[3] ?? 0), String(row[4] ?? "offline")];
    const [allR, weekR, completedR] = await Promise.all([
      db.execute({ sql: "SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ?", args: [discordId] }),
      db.execute({ sql: "SELECT total, parts_cost, labour FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid') AND DATE(created_at) >= ?", args: [discordId, ws] }),
      db.execute({ sql: "SELECT id FROM orders WHERE mechanic_id = ? AND status IN ('approved','paid')", args: [discordId] })
    ]);

    const weekTotal = weekR.rows.reduce((s, r) => s + Number(r[0] ?? 0), 0);
    const weekParts = weekR.rows.reduce((s, r) => s + Number(r[1] ?? 0), 0);
    const weekLabour = weekR.rows.reduce((s, r) => s + Number(r[2] ?? 0), 0);

    embeds.push(new EmbedBuilder()
      .setTitle(`${statusEmoji(status)} ${displayName}`)
      .setColor(COLORS.primary)
      .addFields(
        { name: "Total Orders", value: String(allR.rows.length), inline: true },
        { name: "This Week", value: String(weekR.rows.length), inline: true },
        { name: "Completed", value: String(completedR.rows.length), inline: true },
        { name: "Week Revenue", value: money(weekTotal), inline: true },
        { name: "Parts Cost", value: money(weekParts), inline: true },
        { name: "Labour", value: money(weekLabour), inline: true },
        { name: "Commission Rate", value: `${(commRate * 100).toFixed(0)}%`, inline: true },
        { name: "Expected Payout", value: money(weekLabour * commRate), inline: true },
        { name: "Hours This Week", value: `${hoursWeek.toFixed(1)} hrs`, inline: true }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp()
    );

    if (buttons.length < 5) {
      buttons.push(new ButtonBuilder().setCustomId(`breakdown:expand:${discordId}`).setLabel(`📋 ${displayName}`).setStyle(ButtonStyle.Secondary));
    }
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
  }

  await interaction.editReply({ embeds: embeds.slice(0, 10), components: components.slice(0, 5) });
}
