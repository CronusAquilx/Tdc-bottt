import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from "discord.js";
import { db, getProfile, getGuildConfig, rowToTimeclock } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildTimeclockEmbed, buildClockOutEmbed, COLORS } from "../lib/embeds.js";
import { formatDuration } from "../lib/utils.js";
import { warnedMechanics, stayedIn } from "../lib/warnState.js";

export const data = new SlashCommandBuilder()
  .setName("timeclock")
  .setDescription("Manage timeclock entries (manager+)")
  .addSubcommand(s =>
    s.setName("review")
      .setDescription("Review pending timeclock entries")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("history")
      .setDescription("View timeclock history")
      .addUserOption(o => o.setName("mechanic").setDescription("Target mechanic").setRequired(true))
  )
  .addSubcommand(s =>
    s.setName("force-out")
      .setDescription("Force clock out a specific person (manager+)")
      .addUserOption(o => o.setName("mechanic").setDescription("Person to clock out").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason (optional)"))
  )
  .addSubcommand(s =>
    s.setName("who-is-in")
      .setDescription("See everyone currently clocked in (manager+)")
  )
  .addSubcommand(s =>
    s.setName("reset-all")
      .setDescription("⚠️ Emergency: clock out EVERYONE and clear all warnings (owner only)")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  // ── reset-all (owner only) ───────────────────────────────────────────────────
  if (sub === "reset-all") {
    if (!(await requireRole(interaction, "owner"))) return;
    await interaction.deferReply({ ephemeral: true });

    // Get all active sessions
    const activeR = await db.execute(
      `SELECT id, mechanic_id, clock_in_time FROM timeclock WHERE clock_out_time IS NULL`
    );

    let count = 0;
    const names: string[] = [];

    for (const row of activeR.rows) {
      const tcId       = String(row[0] ?? "");
      const mechanicId = String(row[1] ?? "");
      const clockIn    = String(row[2] ?? "");
      const mins       = (Date.now() - new Date(clockIn).getTime()) / 60000;

      await db.execute({
        sql: `UPDATE timeclock
              SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', warned_at = NULL
              WHERE id = ?`,
        args: [mins, tcId]
      });
      await db.execute({
        sql: `UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline'
              WHERE discord_id = ?`,
        args: [mins / 60, mechanicId]
      });

      const profile = await getProfile(mechanicId);
      names.push(profile?.display_name ?? mechanicId);
      count++;
    }

    // Clear ALL in-memory warn states and stay-in records
    warnedMechanics.clear();
    stayedIn.clear();

    // Also clear any lingering warned_at flags in the DB (belt-and-suspenders)
    await db.execute(`UPDATE timeclock SET warned_at = NULL WHERE warned_at IS NOT NULL`);

    const embed = new EmbedBuilder()
      .setTitle("⚠️  Emergency Clock-Out — Reset Complete")
      .setColor(COLORS.warning)
      .setDescription(
        `**${count}** active session${count !== 1 ? "s" : ""} have been clocked out.\n` +
        `All idle warnings cleared. No more pings will be sent.\n\n` +
        (names.length ? `**Clocked out:**\n${names.map(n => `• ${n}`).join("\n")}` : "Nobody was clocked in.")
      )
      .setFooter({ text: "Tokyo Drift Customs" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Log to log channel
    try {
      if (!interaction.guild) return;
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.log_channel_id) {
        const ch = await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null);
        if (ch?.isTextBased()) {
          await (ch as any).send({
            content: `⚠️ <@${interaction.user.id}> ran an emergency clock-out reset.`,
            embeds: [embed]
          });
        }
      }
    } catch { /* ignore */ }
    return;
  }

  // ── who-is-in ────────────────────────────────────────────────────────────────
  if (sub === "who-is-in") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });

    const activeR = await db.execute(
      `SELECT id, mechanic_id, clock_in_time, warned_at FROM timeclock WHERE clock_out_time IS NULL ORDER BY clock_in_time ASC`
    );

    if (!activeR.rows.length) {
      await interaction.editReply({ content: "✅ Nobody is currently clocked in." });
      return;
    }

    const lines = await Promise.all(activeR.rows.map(async row => {
      const mechanicId = String(row[1] ?? "");
      const clockIn    = String(row[2] ?? "");
      const warnedAt   = row[3] ? String(row[3]) : null;
      const profile    = await getProfile(mechanicId);
      const name       = profile?.display_name ?? mechanicId;
      const mins       = Math.round((Date.now() - new Date(clockIn).getTime()) / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const warnTag    = warnedAt ? " ⚠️ *idle warning sent*" : "";
      return `• **${name}** — <@${mechanicId}> — ${h}h ${m}m${warnTag}`;
    }));

    const embed = new EmbedBuilder()
      .setTitle(`⏰  Currently Clocked In (${activeR.rows.length})`)
      .setColor(COLORS.primary)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Tokyo Drift Customs  ·  Use /timeclock force-out to clock someone out" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── force-out ────────────────────────────────────────────────────────────────
  if (sub === "force-out") {
    if (!(await requireRole(interaction, "manager"))) return;
    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser("mechanic", true);
    const reason = interaction.options.getString("reason") ?? "Clocked out by manager";

    const activeR = await db.execute({
      sql: `SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1`,
      args: [target.id]
    });

    if (!activeR.rows[0]) {
      await interaction.editReply({ content: `❌ <@${target.id}> is not currently clocked in.` });
      return;
    }

    const entry = rowToTimeclock(activeR.rows[0]);
    const mins  = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;

    await db.execute({
      sql: `UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, status = 'approved', warned_at = NULL, notes = ?
            WHERE id = ?`,
      args: [mins, reason, entry.id]
    });
    await db.execute({
      sql: `UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ?, status = 'offline' WHERE discord_id = ?`,
      args: [mins / 60, target.id]
    });

    // Clear warn state for this person
    warnedMechanics.delete(entry.id);
    stayedIn.delete(target.id);

    const profile = await getProfile(target.id);
    const name    = profile?.display_name ?? target.username;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);

    const embed = buildClockOutEmbed(
      name,
      entry.clock_in_time,
      new Date().toISOString().replace("T", " ").slice(0, 19),
      mins,
      0
    );

    // Edit original clock-in message in timeclock channel
    if (entry.clock_message_id && entry.clock_channel_id && interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(entry.clock_channel_id).catch(() => null);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(entry.clock_message_id).catch(() => null);
          if (msg) await msg.edit({ embeds: [embed] });
        }
      } catch { /* ignore */ }
    }

    // Post to timeclock channel with manager note
    if (interaction.guild) {
      try {
        const config = await getGuildConfig(interaction.guild.id);
        if (config?.timeclock_channel_id) {
          const ch = await interaction.guild.channels.fetch(config.timeclock_channel_id).catch(() => null);
          if (ch?.isTextBased()) {
            await (ch as any).send({
              content: `🔴 <@${target.id}> was clocked out by <@${interaction.user.id}> — **${h}h ${m}m**\n> *${reason}*`,
              embeds: [embed]
            });
          }
        }
      } catch { /* ignore */ }
    }

    await interaction.editReply({
      content: `✅ <@${target.id}> (**${name}**) has been clocked out.\n**Shift:** ${h}h ${m}m · *${reason}*`
    });
    return;
  }

  // ── review ───────────────────────────────────────────────────────────────────
  if (!(await requireRole(interaction, "trainer"))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser("mechanic", true);
  const profile = await getProfile(target.id);
  if (!profile) { await interaction.editReply({ content: "❌ Mechanic not found." }); return; }

  if (sub === "review") {
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND status = 'pending' AND clock_out_time IS NOT NULL ORDER BY created_at DESC", args: [target.id] });
    if (!r.rows.length) { await interaction.editReply({ content: `✅ No pending entries for **${profile.display_name}**.` }); return; }
    for (const row of r.rows.slice(0, 5)) {
      const entry = rowToTimeclock(row);
      const embed = buildTimeclockEmbed(profile.display_name, entry.clock_in_time, entry.clock_out_time, entry.duration_minutes, entry.status, entry.notes);
      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`timeclock:approve:${entry.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`timeclock:reject:${entry.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );
      await interaction.followUp({ embeds: [embed], components: [btnRow], ephemeral: true });
    }
    return;
  }

  if (sub === "history") {
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? ORDER BY created_at DESC LIMIT 10", args: [target.id] });
    if (!r.rows.length) { await interaction.editReply({ content: `No timeclock entries for **${profile.display_name}**.` }); return; }
    const lines = r.rows.map(row => {
      const entry = rowToTimeclock(row);
      return `${new Date(entry.clock_in_time).toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${formatDuration(entry.duration_minutes)} — \`${entry.status.toUpperCase()}\``;
    });
    const embed = new EmbedBuilder()
      .setTitle(`⏰ Timeclock History · ${profile.display_name}`)
      .setColor(COLORS.submitted)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }
}
