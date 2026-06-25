import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder
} from "discord.js";
import { db, setSetting } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Clear week stats without paying (manager+)")
  .addSubcommand(sub =>
    sub.setName("all")
       .setDescription("Clear ALL mechanics' week orders — resets every commission total to $0")
  )
  .addSubcommand(sub =>
    sub.setName("player")
       .setDescription("Clear a specific mechanic's week orders only")
       .addUserOption(opt =>
         opt.setName("user")
            .setDescription("Mechanic to clear")
            .setRequired(true)
       )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ ephemeral: true });

  const sub     = interaction.options.getSubcommand();
  const guildId = interaction.guildId ?? "";

  if (sub === "all") {
    const r = await db.execute({
      sql: "UPDATE orders SET status = 'cleared' WHERE status = 'complete' AND (guild_id = ? OR guild_id = '')",
      args: [guildId]
    });
    const count = Number(r.rowsAffected ?? 0);

    await setSetting("order_number_reset_ts", new Date().toISOString());

    const embed = new EmbedBuilder()
      .setTitle("🗑️  WEEK CLEARED — ALL CREW")
      .setColor(COLORS.warning)
      .setDescription(
        `Cleared **${count} order(s)** for all mechanics.\n` +
        "Every week commission total is now **$0**.\n\n" +
        "*Orders are archived but not paid — use `/payall` to pay and clear simultaneously.*"
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "player") {
    const target = interaction.options.getUser("user", true);
    const r = await db.execute({
      sql: "UPDATE orders SET status = 'cleared' WHERE mechanic_id = ? AND status = 'complete' AND (guild_id = ? OR guild_id = '')",
      args: [target.id, guildId]
    });
    const count = Number(r.rowsAffected ?? 0);

    const embed = new EmbedBuilder()
      .setTitle("🗑️  PLAYER STATS CLEARED")
      .setColor(COLORS.warning)
      .setDescription(
        `Cleared **${count} order(s)** for <@${target.id}>.\n` +
        "Their week commission total is now **$0**.\n\n" +
        "*Other mechanics' stats are unchanged.*"
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
