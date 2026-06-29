import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder , MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, statusEmoji } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("crew")
  .setDescription("Crew management (manager+)")
  .addSubcommand(s =>
    s.setName("add")
      .setDescription("Add a crew member")
      .addUserOption(o => o.setName("user").setDescription("Discord user").setRequired(true))
      .addStringOption(o =>
        o.setName("role").setDescription("Role").setRequired(true)
          .addChoices(
            { name: "Manager", value: "manager" },
            { name: "Trainer", value: "trainer" },
            { name: "Mechanic", value: "mechanic" }
          )
      )
      .addStringOption(o => o.setName("display_name").setDescription("Display name").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("remove")
      .setDescription("Remove a crew member")
      .addUserOption(o => o.setName("user").setDescription("Discord user").setRequired(true))
  )
  .addSubcommand(s => s.setName("list").setDescription("List all crew members"))
  .addSubcommand(s =>
    s.setName("status")
      .setDescription("Update a crew member's status")
      .addUserOption(o => o.setName("user").setDescription("Discord user").setRequired(true))
      .addStringOption(o =>
        o.setName("status").setDescription("New status").setRequired(true)
          .addChoices(
            { name: "Online", value: "online" },
            { name: "Offline", value: "offline" },
            { name: "On Break", value: "on_break" }
          )
      )
  )
  .addSubcommand(s =>
    s.setName("setcityid")
      .setDescription("Set a crew member's in-city ID (manager+)")
      .addUserOption(o => o.setName("user").setDescription("The crew member").setRequired(true))
      .addStringOption(o => o.setName("city_id").setDescription("Their in-city name / ID").setRequired(true).setMaxLength(40))
  )
  .addSubcommand(s =>
    s.setName("mycityid")
      .setDescription("Set your own in-city ID")
      .addStringOption(o => o.setName("city_id").setDescription("Your in-city name / ID").setRequired(true).setMaxLength(40))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const target = interaction.options.getUser("user", true);
      const role = interaction.options.getString("role", true);
      const displayName = interaction.options.getString("display_name", true);
      await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name, commission_rate) VALUES (?, ?, 0.3)", args: [target.id, displayName] });
      await db.execute({ sql: "UPDATE profiles SET display_name = ?, commission_rate = 0.3 WHERE discord_id = ?", args: [displayName, target.id] });
      await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [target.id] });
      await db.execute({ sql: "INSERT INTO user_roles (discord_id, role) VALUES (?, ?)", args: [target.id, role] });
      const caller = await getProfile(interaction.user.id);
      const embed = new EmbedBuilder()
        .setTitle("✅ Crew Member Added")
        .setColor(COLORS.approved)
        .addFields(
          { name: "User", value: displayName, inline: true },
          { name: "Role", value: role.toUpperCase(), inline: true },
          { name: "Added By", value: caller?.display_name ?? interaction.user.username, inline: true }
        )
        .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      await logToChannel(interaction, embed);
    } catch (err: any) {
      console.error("[TDC] crew add error:", err);
      try { await interaction.editReply({ content: `❌ Failed to add crew member: ${err?.message ?? "Unknown error"}` }); } catch { /* ignore */ }
    }
    return;
  }

  if (sub === "remove") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user", true);
    const profile = await getProfile(target.id);
    if (!profile) { await interaction.editReply({ content: "❌ User not found." }); return; }
    await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [target.id] });
    const caller = await getProfile(interaction.user.id);
    const embed = new EmbedBuilder()
      .setTitle("🗑️ Crew Member Removed")
      .setColor(COLORS.rejected)
      .addFields(
        { name: "User", value: profile.display_name, inline: true },
        { name: "Removed By", value: caller?.display_name ?? interaction.user.username, inline: true }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    await logToChannel(interaction, embed);
    return;
  }

  if (sub === "list") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roles = ["owner", "manager", "trainer", "mechanic"];
    const embed = new EmbedBuilder()
      .setTitle("👥 Tokyo Drift Customs — Crew")
      .setColor(COLORS.primary)
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    for (const role of roles) {
      const r = await db.execute({
        sql: `SELECT p.discord_id, p.display_name, p.commission_rate, p.hours_worked_this_week, p.status
              FROM user_roles ur JOIN profiles p ON p.discord_id = ur.discord_id WHERE ur.role = ?`,
        args: [role]
      });
      if (!r.rows.length) continue;
      const lines = r.rows.map(row =>
        `${statusEmoji(String(row[4] ?? "offline"))} **${String(row[1])}** (<@${String(row[0])}>) · ${(Number(row[2] ?? 0.3) * 100).toFixed(0)}% · ${Number(row[3] ?? 0).toFixed(1)} hrs/wk`
      );
      embed.addFields({ name: `${role.charAt(0).toUpperCase() + role.slice(1)}s (${r.rows.length})`, value: lines.join("\n").slice(0, 1024) });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "status") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user", true);
    const status = interaction.options.getString("status", true);
    const profile = await getProfile(target.id);
    if (!profile) { await interaction.editReply({ content: "❌ User not found." }); return; }
    await db.execute({ sql: "UPDATE profiles SET status = ? WHERE discord_id = ?", args: [status, target.id] });
    await interaction.editReply({ content: `✅ **${profile.display_name}** status → ${statusEmoji(status)} **${status.replace("_", " ").toUpperCase()}**` });
    return;
  }

  if (sub === "setcityid") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target  = interaction.options.getUser("user", true);
    const cityId  = interaction.options.getString("city_id", true).trim();
    const profile = await getProfile(target.id);
    if (!profile) { await interaction.editReply({ content: "❌ That user isn't in the crew. Add them first with `/crew add`." }); return; }
    await db.execute({ sql: "UPDATE profiles SET in_city_id = ? WHERE discord_id = ?", args: [cityId, target.id] });
    // Also try to update their server nickname
    try {
      const member = await interaction.guild!.members.fetch(target.id);
      await member.setNickname(cityId, "In-city ID updated by manager");
    } catch { /* owner or missing perms — ignore */ }
    await interaction.editReply({ content: `✅ **${profile.display_name}**'s in-city ID set to **${cityId}**.` });
    return;
  }

  if (sub === "mycityid") {
    if (!(await requireRole(interaction, "mechanic"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cityId  = interaction.options.getString("city_id", true).trim();
    const profile = await getProfile(interaction.user.id);
    if (!profile) { await interaction.editReply({ content: "❌ You're not in the crew yet." }); return; }
    await db.execute({ sql: "UPDATE profiles SET in_city_id = ? WHERE discord_id = ?", args: [cityId, interaction.user.id] });
    // Try to update their nickname too
    try {
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      await member.setNickname(cityId, "In-city ID self-updated");
    } catch { /* owner or missing perms — ignore */ }
    await interaction.editReply({ content: `✅ Your in-city ID has been set to **${cityId}**.` });
    return;
  }
}

async function logToChannel(interaction: ChatInputCommandInteraction, embed: EmbedBuilder) {
  try {
    if (!interaction.guild) return;
    const config = await getGuildConfig(interaction.guild.id);
    if (!config?.log_channel_id) return;
    const ch = await interaction.guild.channels.fetch(config.log_channel_id);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
  } catch { /* ignore */ }
}
