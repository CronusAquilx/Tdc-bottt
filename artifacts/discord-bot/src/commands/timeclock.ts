import {
  SlashCommandBuilder, ChatInputCommandInteraction
} from "discord.js";
import { db, getProfile, rowToTimeclock, getGuildConfig } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { buildClockInEmbed, buildClockOutEmbed } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

export const data = new SlashCommandBuilder()
  .setName("clock")
  .setDescription("Time tracking (or use the buttons in the timeclock channel)")
  .addSubcommand(s => s.setName("in").setDescription("Clock in to start your shift"))
  .addSubcommand(s =>
    s.setName("out")
      .setDescription("Clock out to end your shift")
      .addStringOption(o => o.setName("notes").setDescription("Session notes (optional)"))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "in") {
    await interaction.deferReply();
    const active = await db.execute({ sql: "SELECT id FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL LIMIT 1", args: [interaction.user.id] });
    if (active.rows[0]) {
      await interaction.editReply({ content: `⚠️ <@${interaction.user.id}> You're already clocked in. Use \`/clock out\` or the **Clock Out** button.` });
      return;
    }
    const id = randomUUID();
    await db.execute({ sql: "INSERT INTO timeclock (id, mechanic_id, clock_in_time) VALUES (?, ?, datetime('now'))", args: [id, interaction.user.id] });
    const r = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [id] });
    const entry = rowToTimeclock(r.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const displayName = profile?.display_name
      ?? (interaction.member as any)?.displayName
      ?? interaction.user.globalName
      ?? interaction.user.username;
    const embed = buildClockInEmbed(displayName, entry.clock_in_time);

    // Post to timeclock channel if configured, reply publicly
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      if (config?.timeclock_channel_id) {
        try {
          const ch = await interaction.guild.channels.fetch(config.timeclock_channel_id);
          if (ch?.isTextBased()) {
            const msg = await (ch as any).send({ embeds: [embed] });
            await db.execute({ sql: "UPDATE timeclock SET clock_message_id = ?, clock_channel_id = ? WHERE id = ?", args: [msg.id, ch.id, id] });
          }
        } catch { /* ignore */ }
      }
    }

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "out") {
    await interaction.deferReply();
    const notes = interaction.options.getString("notes");
    const active = await db.execute({ sql: "SELECT * FROM timeclock WHERE mechanic_id = ? AND clock_out_time IS NULL ORDER BY created_at DESC LIMIT 1", args: [interaction.user.id] });
    if (!active.rows[0]) {
      await interaction.editReply({ content: `❌ <@${interaction.user.id}> You're not clocked in.` });
      return;
    }
    const entry = rowToTimeclock(active.rows[0]);
    const mins = (Date.now() - new Date(entry.clock_in_time).getTime()) / 60000;
    await db.execute({ sql: "UPDATE timeclock SET clock_out_time = datetime('now'), duration_minutes = ?, notes = ?, status = 'approved' WHERE id = ?", args: [mins, notes ?? null, entry.id] });
    await db.execute({ sql: "UPDATE profiles SET hours_worked_this_week = hours_worked_this_week + ? WHERE discord_id = ?", args: [mins / 60, entry.mechanic_id] });
    const ur = await db.execute({ sql: "SELECT * FROM timeclock WHERE id = ?", args: [entry.id] });
    const updated = rowToTimeclock(ur.rows[0]);
    const profile = await getProfile(interaction.user.id);
    const embed = buildClockOutEmbed(profile?.display_name ?? interaction.user.username, updated.clock_in_time, updated.clock_out_time!, mins);

    // Edit the original clock-in message in the timeclock channel
    if (updated.clock_message_id && updated.clock_channel_id && interaction.guild) {
      try {
        const ch = await interaction.guild.channels.fetch(updated.clock_channel_id);
        if (ch?.isTextBased()) {
          const msg = await (ch as any).messages.fetch(updated.clock_message_id);
          await msg.edit({ embeds: [embed] });
        }
      } catch { /* ignore */ }
    }

    await interaction.editReply({ embeds: [embed] });
  }
}
