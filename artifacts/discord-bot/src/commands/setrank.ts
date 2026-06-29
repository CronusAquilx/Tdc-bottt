import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder , MessageFlags} from "discord.js";
import { db, getProfile } from "../db.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("setrank")
  .setDescription("Assign or remove a rank (owner/manager) for a crew member")
  .addUserOption(o => o.setName("user").setDescription("The crew member").setRequired(true))
  .addStringOption(o =>
    o.setName("rank").setDescription("Rank to assign (leave blank to clear)").setRequired(false)
      .addChoices(
        { name: "👑 Owner",   value: "owner"   },
        { name: "🔧 Manager", value: "manager" }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser("user", true);
  const rank   = interaction.options.getString("rank");

  if (!rank) {
    // Clear any existing rank
    await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [target.id] });
    await interaction.editReply({ content: `✅ Cleared rank for **${target.displayName ?? target.username}**.` });
    return;
  }

  // Upsert rank in user_roles (no id column in this table)
  await db.execute({
    sql: `INSERT INTO user_roles (discord_id, role)
          VALUES (?, ?)
          ON CONFLICT(discord_id, role) DO NOTHING`,
    args: [target.id, rank]
  });
  // Remove any old conflicting role for this user first, then re-insert cleanly
  await db.execute({ sql: `DELETE FROM user_roles WHERE discord_id = ? AND role != ?`, args: [target.id, rank] });

  // Ensure a profile exists for them
  const existing = await getProfile(target.id);
  if (!existing) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO profiles (discord_id, display_name) VALUES (?, ?)`,
      args: [target.id, target.displayName ?? target.username]
    });
  }

  const label = rank === "owner" ? "👑 Owner" : "🔧 Manager";
  const embed = new EmbedBuilder()
    .setTitle("✅  Rank Assigned")
    .setColor(COLORS.approved)
    .setDescription(`**${target.displayName ?? target.username}** has been given the **${label}** rank.`)
    .setThumbnail(target.displayAvatarURL())
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
