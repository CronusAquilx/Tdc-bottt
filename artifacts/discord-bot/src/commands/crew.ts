import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder , MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig } from "../db.js";
import { requireRole, detectUserRoleLevel } from "../lib/roles.js";
import { COLORS, statusEmoji, money } from "../lib/embeds.js";

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
  )
  .addSubcommand(s =>
    s.setName("info")
      .setDescription("Full summary for a crew member (manager+)")
      .addUserOption(o => o.setName("user").setDescription("Crew member to look up (leave blank for yourself)").setRequired(false))
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
      const existingProfile = await getProfile(target.id);
      const isNew = !existingProfile;
      await db.execute({ sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name, commission_rate) VALUES (?, ?, 0.3)", args: [target.id, displayName] });
      await db.execute({ sql: "UPDATE profiles SET display_name = ? WHERE discord_id = ?", args: [displayName, target.id] });
      await db.execute({ sql: "DELETE FROM user_roles WHERE discord_id = ?", args: [target.id] });
      await db.execute({ sql: "INSERT INTO user_roles (discord_id, role) VALUES (?, ?)", args: [target.id, role] });
      const caller = await getProfile(interaction.user.id);
      const updatedProfile = await getProfile(target.id);
      const rateStr = `${Math.round((updatedProfile?.commission_rate ?? 0.3) * 100)}%`;
      const embed = new EmbedBuilder()
        .setTitle("✅ Crew Member Added")
        .setColor(COLORS.approved)
        .addFields(
          { name: "User", value: displayName, inline: true },
          { name: "Role", value: role.toUpperCase(), inline: true },
          { name: "Commission", value: isNew ? `${rateStr} (default)` : `${rateStr} (preserved)`, inline: true },
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
    try {
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      await member.setNickname(cityId, "In-city ID self-updated");
    } catch { /* owner or missing perms — ignore */ }
    await interaction.editReply({ content: `✅ Your in-city ID has been set to **${cityId}**.` });
    return;
  }

  if (sub === "info") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const callerRole = await detectUserRoleLevel(interaction);
    const isManager = callerRole === "manager" || callerRole === "owner";

    const targetUser = interaction.options.getUser("user");
    if (targetUser && !isManager) {
      await interaction.editReply({ content: "❌ Only managers can look up other crew members." });
      return;
    }
    const targetId = targetUser?.id ?? interaction.user.id;

    const [profile, roleRow] = await Promise.all([
      getProfile(targetId),
      db.execute({ sql: "SELECT role FROM user_roles WHERE discord_id = ?", args: [targetId] })
    ]);

    if (!profile) {
      await interaction.editReply({ content: "❌ That user isn't in the crew." });
      return;
    }

    const role = roleRow.rows[0] ? String(roleRow.rows[0][0]) : "none";

    const SINCE_RESET_SQL =
      `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
    const DONE = `status IN ('complete', 'approved', 'paid')`;

    const [weekStats, allTimeStats, draftCount] = await Promise.all([
      db.execute({
        sql: `SELECT COUNT(*) as orders, COALESCE(SUM(COALESCE(customer_total_override, total)), 0) as revenue, COALESCE(SUM(labour), 0) as labour
              FROM orders WHERE mechanic_id = ? AND ${DONE} AND ${SINCE_RESET_SQL}`,
        args: [targetId]
      }),
      db.execute({
        sql: `SELECT COUNT(*) as orders, COALESCE(SUM(COALESCE(customer_total_override, total)), 0) as revenue
              FROM orders WHERE mechanic_id = ? AND ${DONE}`,
        args: [targetId]
      }),
      db.execute({
        sql: `SELECT COUNT(*) FROM orders WHERE mechanic_id = ? AND status = 'draft'`,
        args: [targetId]
      })
    ]);

    const weekOrders  = Number(weekStats.rows[0]?.[0] ?? 0);
    const weekRevenue = Number(weekStats.rows[0]?.[1] ?? 0);
    const weekLabour  = Number(weekStats.rows[0]?.[2] ?? 0);
    const allOrders   = Number(allTimeStats.rows[0]?.[0] ?? 0);
    const allRevenue  = Number(allTimeStats.rows[0]?.[1] ?? 0);
    const drafts      = Number(draftCount.rows[0]?.[0] ?? 0);

    const rate = profile.commission_rate;
    const weekCommission = Math.round(weekLabour * rate);

    const roleDisplay: Record<string, string> = {
      owner: "👑 Owner", manager: "🔑 Manager", trainer: "🎓 Trainer", mechanic: "🔧 Mechanic"
    };

    const statusDisplay = statusEmoji(profile.status) + " " + profile.status.replace("_", " ").toUpperCase();

    const embed = new EmbedBuilder()
      .setTitle(`👤  ${profile.display_name}  ·  CREW INFO`)
      .setColor(COLORS.primary)
      .addFields(
        { name: "🎭 Role",         value: roleDisplay[role] ?? role,                                       inline: true },
        { name: "📡 Status",       value: statusDisplay,                                                   inline: true },
        { name: "💵 Commission",   value: `**${(rate * 100).toFixed(0)}%** of labour`,                     inline: true },
        { name: "📋 Channel",      value: profile.sales_channel_id ? `<#${profile.sales_channel_id}>` : "*not set*", inline: true },
        { name: "🪪 City ID",      value: (profile as any).in_city_id ?? "*not set*",                     inline: true },
        { name: "⏱️ Hours (Wk)",  value: `**${profile.hours_worked_this_week.toFixed(1)}h**`,             inline: true },
        { name: "📦 This Period",  value: `**${weekOrders}** orders  ·  ${money(weekRevenue)} revenue\n💵 Commission: **${money(weekCommission)}**`, inline: false },
        { name: "🏆 All-Time",     value: `**${allOrders}** orders  ·  **${money(allRevenue)}** total customer revenue`, inline: false },
      );

    if (drafts > 0) {
      embed.addFields({ name: "✏️ Open Drafts", value: `**${drafts}** draft order${drafts > 1 ? "s" : ""} in progress`, inline: false });
    }

    embed.setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
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
