import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags, ChannelType, Guild } from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds, checkpointDatabase, saveDatabaseSnapshot } from "../db.js";
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
  )
  .addSubcommand(s =>
    s.setName("sync")
      .setDescription("Synchronize the crew database and Discord roles (manager+)")
      .addStringOption(o =>
        o.setName("mode")
          .setDescription("Use full to import mechanic-role members and link their sales channels")
          .setRequired(false)
          .addChoices(
            { name: "Roles only", value: "roles" },
            { name: "Full crew + sales channels", value: "full" }
          )
      )
  );

export interface FullCrewSyncResult {
  scanned: number;
  added: number;
  alreadyInCrew: number;
  linked: number;
  alreadyLinked: number;
  noChannel: number;
  failed: number;
  details: string[];
  error?: string;
}

export interface CrewHealthResult {
  repaired: boolean;
  scannedDiscordMechanics: number;
  scannedDatabaseMechanics: number;
  profilesCreated: number;
  databaseRolesAdded: number;
  discordRolesApplied: number;
  channelsLinked: number;
  alreadyHealthy: number;
  missingDiscordMembers: string[];
  missingProfiles: string[];
  missingMechanicRoles: string[];
  missingSalesChannels: string[];
  staleSalesLinks: string[];
  failures: string[];
  error?: string;
}

function emptyFullCrewSyncResult(): FullCrewSyncResult {
  return {
    scanned: 0,
    added: 0,
    alreadyInCrew: 0,
    linked: 0,
    alreadyLinked: 0,
    noChannel: 0,
    failed: 0,
    details: []
  };
}

function emptyCrewHealthResult(repaired: boolean): CrewHealthResult {
  return {
    repaired,
    scannedDiscordMechanics: 0,
    scannedDatabaseMechanics: 0,
    profilesCreated: 0,
    databaseRolesAdded: 0,
    discordRolesApplied: 0,
    channelsLinked: 0,
    alreadyHealthy: 0,
    missingDiscordMembers: [],
    missingProfiles: [],
    missingMechanicRoles: [],
    missingSalesChannels: [],
    staleSalesLinks: [],
    failures: []
  };
}

function channelSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function findSalesChannel(
  channels: Array<{ id: string; name: string }>,
  names: string[]
): { id: string; name: string } | null {
  const slugs = [...new Set(names.map(channelSlug).filter(Boolean))];
  const candidates = new Set(slugs.flatMap(slug => [slug, `sales-${slug}`]));
  const matches = channels.filter(channel => candidates.has(channelSlug(channel.name)));
  if (!matches.length) return null;

  // Prefer the conventional sales-name match when both "melvin" and
  // "sales-melvin" exist.
  return matches.sort((a, b) => {
    const aSales = a.name.toLowerCase().startsWith("sales-") ? 1 : 0;
    const bSales = b.name.toLowerCase().startsWith("sales-") ? 1 : 0;
    return bSales - aSales;
  })[0] ?? null;
}

/**
 * Compare the Discord mechanic role, saved crew records, and sales-channel links.
 * Repair mode only adds missing membership/roles and repairs links to existing
 * channels; it never deletes profiles, orders, or channels.
 */
export async function runCrewHealthCheck(guild: Guild, repaired = false): Promise<CrewHealthResult> {
  const result = emptyCrewHealthResult(repaired);
  const config = await getGuildConfig(guild.id);
  const mechanicRoleIds = splitRoleIds(config?.mechanic_role_id);

  if (!mechanicRoleIds.length) {
    result.error = "No Discord mechanic role is configured. Set it up in Admin Panel → Config first.";
    return result;
  }

  const members = await guild.members.fetch();
  const discordMechanics = [...members.values()].filter(member =>
    !member.user.bot && member.roles.cache.some(role => mechanicRoleIds.includes(role.id))
  );
  result.scannedDiscordMechanics = discordMechanics.length;

  let textChannels: Array<{ id: string; name: string }> = [];
  try {
    const channels = await guild.channels.fetch();
    textChannels = [...channels.values()]
      .filter(channel => channel?.type === ChannelType.GuildText)
      .map(channel => ({ id: channel!.id, name: channel!.name }));
  } catch {
    result.failures.push("Could not fetch the server's channels.");
  }

  const databaseRows = await db.execute({
    sql: `SELECT DISTINCT p.discord_id, p.display_name, p.sales_channel_id
          FROM profiles p
          INNER JOIN user_roles ur ON ur.discord_id = p.discord_id AND ur.role = 'mechanic'
          WHERE NOT EXISTS (
            SELECT 1 FROM user_roles senior
            WHERE senior.discord_id = p.discord_id
              AND senior.role IN ('owner', 'manager', 'trainer')
          )
          ORDER BY p.display_name`,
    args: []
  });
  result.scannedDatabaseMechanics = databaseRows.rows.length;

  const databaseIds = new Set(databaseRows.rows.map(row => String(row[0] ?? "")));
  const profileMap = new Map<string, { displayName: string; salesChannelId: string | null }>(
    databaseRows.rows.map(row => [
      String(row[0] ?? ""),
      { displayName: String(row[1] ?? row[0] ?? "Unknown"), salesChannelId: row[2] ? String(row[2]) : null }
    ])
  );

  for (const member of discordMechanics) {
    const displayName = member.displayName?.trim() || member.user.globalName?.trim() || member.user.username;
    const roleRows = await db.execute({
      sql: "SELECT role FROM user_roles WHERE discord_id = ?",
      args: [member.id]
    });
    const roles = roleRows.rows.map(row => String(row[0] ?? ""));
    const hasSeniorRole = roles.some(role => ["owner", "manager", "trainer"].includes(role));
    const profile = await getProfile(member.id);

    if (!profile && !hasSeniorRole) {
      result.missingProfiles.push(displayName);
      if (repaired) {
        try {
          await db.execute({
            sql: "INSERT INTO profiles (discord_id, display_name, commission_rate) VALUES (?, ?, 0.3)",
            args: [member.id, displayName]
          });
          await db.execute({
            sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, 'mechanic')",
            args: [member.id]
          });
          result.profilesCreated++;
          result.databaseRolesAdded++;
          profileMap.set(member.id, { displayName, salesChannelId: null });
        } catch (err: any) {
          result.failures.push(`${displayName}: ${err?.message ?? "could not create crew profile"}`);
        }
      }
    } else if (!roles.includes("mechanic") && !hasSeniorRole) {
      result.missingProfiles.push(`${displayName} (database mechanic role missing)`);
      if (repaired) {
        try {
          await db.execute({
            sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, 'mechanic')",
            args: [member.id]
          });
          result.databaseRolesAdded++;
          if (profile) profileMap.set(member.id, { displayName: profile.display_name, salesChannelId: profile.sales_channel_id });
        } catch (err: any) {
          result.failures.push(`${displayName}: ${err?.message ?? "could not restore database mechanic role"}`);
        }
      }
    }
  }

  for (const [memberId, profile] of profileMap) {
    const member = members.get(memberId);
    if (!member) {
      result.missingDiscordMembers.push(profile.displayName);
      continue;
    }

    if (!member.roles.cache.some(role => mechanicRoleIds.includes(role.id))) {
      result.missingMechanicRoles.push(profile.displayName);
      if (repaired) {
        try {
          for (const roleId of mechanicRoleIds) {
            if (!member.roles.cache.has(roleId)) {
              await member.roles.add(roleId, "Crew health repair");
              result.discordRolesApplied++;
            }
          }
        } catch (err: any) {
          result.failures.push(`${profile.displayName}: ${err?.message ?? "could not apply mechanic Discord role"}`);
        }
      }
    }

    const currentChannel = profile.salesChannelId
      ? textChannels.find(channel => channel.id === profile.salesChannelId)
      : null;
    if (profile.salesChannelId && !currentChannel) {
      result.staleSalesLinks.push(profile.displayName);
    }

    const matchingChannel = findSalesChannel(textChannels, [profile.displayName]);
    const salesChannel = currentChannel ?? matchingChannel;
    if (salesChannel) {
      if (profile.salesChannelId === salesChannel.id) {
        result.alreadyHealthy++;
      } else if (repaired) {
        try {
          await db.execute({
            sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?",
            args: [salesChannel.id, memberId]
          });
          result.channelsLinked++;
        } catch (err: any) {
          result.failures.push(`${profile.displayName}: ${err?.message ?? "could not link sales channel"}`);
        }
      } else {
        result.channelsLinked++;
      }
    } else {
      result.missingSalesChannels.push(profile.displayName);
    }
  }

  // A Discord-role mechanic with no saved profile may not have been added to
  // profileMap in scan mode, but is still reported above as needing repair.
  if (repaired) await saveDatabaseSnapshot();
  return result;
}

export function buildCrewHealthEmbed(result: CrewHealthResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(result.repaired ? "🛠️  CREW REPAIR COMPLETE" : "🩺  CREW HEALTH CHECK")
    .setColor(result.error ? COLORS.rejected : result.failures.length ? COLORS.warning : COLORS.approved)
    .setFooter({ text: "Tokyo Drift Customs" })
    .setTimestamp();

  if (result.error) return embed.setDescription(`❌ ${result.error}`);

  const attention: string[] = [];
  if (result.missingProfiles.length) attention.push(`Profiles / database roles: ${result.missingProfiles.slice(0, 6).join(", ")}`);
  if (result.missingDiscordMembers.length) attention.push(`Members no longer in this server: ${result.missingDiscordMembers.slice(0, 6).join(", ")}`);
  if (result.missingMechanicRoles.length) attention.push(`Missing Discord mechanic role: ${result.missingMechanicRoles.slice(0, 6).join(", ")}`);
  if (result.staleSalesLinks.length) attention.push(`Stale sales-channel links: ${result.staleSalesLinks.slice(0, 6).join(", ")}`);
  if (result.missingSalesChannels.length) attention.push(`No matching sales channel: ${result.missingSalesChannels.slice(0, 6).join(", ")}`);
  if (result.failures.length) attention.push(`Failures: ${result.failures.slice(0, 6).join(", ")}`);

  return embed.setDescription(
    `Scanned **${result.scannedDiscordMechanics}** Discord mechanics and **${result.scannedDatabaseMechanics}** saved mechanics.\n\n` +
    (result.repaired
      ? `✅ **${result.profilesCreated}** profiles created\n` +
        `🗃️ **${result.databaseRolesAdded}** database mechanic roles restored\n` +
        `🎭 **${result.discordRolesApplied}** Discord mechanic roles applied\n` +
        `🔗 **${result.channelsLinked}** sales channels linked\n`
      : `✅ **${result.alreadyHealthy}** existing links and records are healthy\n`) +
    (attention.length
      ? `\n**Needs attention:**\n${attention.map(item => `• ${item}`).join("\n")}`
      : "\n✨ Everything is aligned.")
  );
}

export async function syncFullCrew(guild: Guild): Promise<FullCrewSyncResult> {
  const result = emptyFullCrewSyncResult();
  const config = await getGuildConfig(guild.id);
  const mechanicRoleIds = splitRoleIds(config?.mechanic_role_id);

  if (!mechanicRoleIds.length) {
    result.error = "No Discord mechanic role is configured. Set it up in Admin Panel → Config first.";
    return result;
  }

  const members = await guild.members.fetch();
  const mechanicMembers = [...members.values()].filter(member =>
    !member.user.bot && member.roles.cache.some(role => mechanicRoleIds.includes(role.id))
  );
  result.scanned = mechanicMembers.length;

  let textChannels: Array<{ id: string; name: string }> = [];
  try {
    const channels = await guild.channels.fetch();
    textChannels = [...channels.values()]
      .filter(channel => channel?.type === ChannelType.GuildText)
      .map(channel => ({ id: channel!.id, name: channel!.name }));
  } catch {
    result.details.push("Could not fetch the server's channels.");
  }

  for (const member of mechanicMembers) {
    const displayName = member.displayName?.trim() || member.user.globalName?.trim() || member.user.username;
    try {
      const profile = await getProfile(member.id);
      const roleRows = await db.execute({
        sql: "SELECT role FROM user_roles WHERE discord_id = ?",
        args: [member.id]
      });

      if (!profile) {
        await db.execute({
          sql: "INSERT OR IGNORE INTO profiles (discord_id, display_name, commission_rate) VALUES (?, ?, 0.3)",
          args: [member.id, displayName]
        });
      }

      if (!roleRows.rows.length) {
        await db.execute({
          sql: "INSERT OR IGNORE INTO user_roles (discord_id, role) VALUES (?, 'mechanic')",
          args: [member.id]
        });
        result.added++;
      } else {
        result.alreadyInCrew++;
      }

      const matchingChannel = findSalesChannel(
        textChannels,
        [displayName, profile?.display_name ?? ""]
      );
      const currentChannel = profile?.sales_channel_id
        ? textChannels.find(channel => channel.id === profile.sales_channel_id)
        : null;
      const salesChannel = matchingChannel ?? currentChannel;

      if (salesChannel) {
        if (profile?.sales_channel_id === salesChannel.id) {
          result.alreadyLinked++;
        } else {
          await db.execute({
            sql: "UPDATE profiles SET sales_channel_id = ? WHERE discord_id = ?",
            args: [salesChannel.id, member.id]
          });
          result.linked++;
        }
      } else {
        result.noChannel++;
        result.details.push(`${displayName}: no channel named ${channelSlug(displayName)} or sales-${channelSlug(displayName)}`);
      }
    } catch (err: any) {
      result.failed++;
      result.details.push(`${displayName}: ${err?.message ?? "sync failed"}`);
    }
  }

  await saveDatabaseSnapshot();
  return result;
}

export function buildFullCrewSyncEmbed(result: FullCrewSyncResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("🔄  FULL CREW SYNC")
    .setColor(result.error ? COLORS.rejected : COLORS.approved)
    .setFooter({ text: "Tokyo Drift Customs" })
    .setTimestamp();

  if (result.error) {
    return embed.setDescription(`❌ ${result.error}`);
  }

  const details = result.details.length
    ? `\n\n**Needs attention:**\n${result.details.slice(0, 8).map(detail => `• ${detail}`).join("\n")}`
    : "";

  return embed.setDescription(
    `Scanned **${result.scanned}** members with the configured mechanic role.\n\n` +
    `✅ **${result.added}** added to the crew\n` +
    `↪️ **${result.alreadyInCrew}** already in the crew (skipped)\n` +
    `🔗 **${result.linked}** sales channels linked\n` +
    `✓ **${result.alreadyLinked}** sales channels already linked\n` +
    `⚠️ **${result.noChannel}** without a matching sales channel\n` +
    (result.failed > 0 ? `❌ **${result.failed}** failed\n` : "") +
    details
  );
}

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
      await saveDatabaseSnapshot();
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

  if (sub === "sync") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild!;
    const mode = interaction.options.getString("mode") ?? "roles";
    if (mode === "full") {
      try {
        const result = await syncFullCrew(guild);
        await interaction.editReply({ embeds: [buildFullCrewSyncEmbed(result)] });
      } catch (err: any) {
        await interaction.editReply({ content: `❌ Full crew sync failed: ${err?.message ?? "Unknown error"}` });
      }
      return;
    }

    const config = await getGuildConfig(guild.id);

    const roleMap: Record<string, string[]> = {
      owner:    splitRoleIds(config?.owner_role_id),
      manager:  splitRoleIds(config?.manager_role_id),
      trainer:  splitRoleIds(config?.trainer_role_id),
      mechanic: splitRoleIds(config?.mechanic_role_id),
    };

    const crewRows = await db.execute(
      "SELECT ur.discord_id, ur.role, p.display_name FROM user_roles ur JOIN profiles p ON p.discord_id = ur.discord_id"
    );

    let synced = 0;
    let failed = 0;
    const skipped: string[] = [];

    for (const row of crewRows.rows) {
      const userId         = String(row[0] ?? "");
      const role           = String(row[1] ?? "");
      const displayName    = String(row[2] ?? userId);
      const discordRoleIds = roleMap[role] ?? [];
      if (!discordRoleIds.length) {
        skipped.push(`${displayName} (no Discord role configured for ${role})`);
        continue;
      }
      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) { skipped.push(`${displayName} (not in server)`); continue; }
        for (const rid of discordRoleIds) {
          if (!member.roles.cache.has(rid)) {
            await member.roles.add(rid, "Crew sync by manager");
          }
        }
        synced++;
      } catch { failed++; }
    }

    const syncEmbed = new EmbedBuilder()
      .setTitle("🔄  CREW SYNC COMPLETE")
      .setColor(COLORS.approved)
      .setDescription(
        `Scanned **${crewRows.rows.length}** crew members and re-applied their Discord roles.\n\n` +
        `✅ **${synced}** synced successfully\n` +
        (failed > 0 ? `❌ **${failed}** failed (bot may lack role permissions)\n` : "") +
        (skipped.length > 0
          ? `⚠️ **${skipped.length}** skipped:\n${skipped.map(s => `· ${s}`).join("\n")}`
          : "")
      )
      .setFooter({ text: "Tokyo Drift Customs" })
      .setTimestamp();

    await interaction.editReply({ embeds: [syncEmbed] });
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
