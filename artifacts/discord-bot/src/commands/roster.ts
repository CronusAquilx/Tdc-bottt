import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, UserSelectMenuBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder
} from "discord.js";
import { db, getProfile } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("roster")
  .setDescription("Manage the crew roster")
  .addSubcommand(s =>
    s.setName("create")
      .setDescription("Add crew members to the roster (manager+)")
  )
  .addSubcommand(s =>
    s.setName("clear")
      .setDescription("Remove everyone from the roster (owner only)")
  )
  .addSubcommand(s =>
    s.setName("remove")
      .setDescription("Remove a specific member from the roster (manager+)")
      .addUserOption(o => o.setName("member").setDescription("The member to remove").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "create") {
    if (!(await requireRole(interaction, "manager"))) return;

    const embed = new EmbedBuilder()
      .setTitle("👥  Add Crew Members")
      .setColor(COLORS.primary)
      .setDescription(
        "**Step 1 of 2 — Pick the crew members to add.**\n\n" +
        "Select up to 10 people at once. You'll assign their roles in the next step."
      )
      .setFooter({ text: FOOTER });

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId("roster:addmembers")
        .setPlaceholder("Select crew members...")
        .setMinValues(1)
        .setMaxValues(10)
    );

    await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
    return;
  }

  if (sub === "clear") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ ephemeral: true });
    await db.execute("DELETE FROM user_roles");
    await db.execute("DELETE FROM profiles");
    await interaction.editReply({ content: "✅ Roster cleared. All crew members and their data have been removed." });
    return;
  }

  if (sub === "remove") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getUser("member", true);
    const profile = await getProfile(target.id);
    if (!profile) {
      await interaction.editReply({ content: "❌ That user isn't in the crew." });
      return;
    }
    await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [target.id] });
    await db.execute({ sql: "DELETE FROM profiles WHERE discord_id = ?", args: [target.id] });
    await interaction.editReply({ content: `✅ **${profile.display_name}** removed from the roster.` });
    return;
  }
}
