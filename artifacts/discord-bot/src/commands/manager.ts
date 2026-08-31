import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder , MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("manager")
  .setDescription("Manager commission settings (owner only)")
  .addSubcommand(s =>
    s.setName("view")
      .setDescription("View manager commission setup and estimated earnings this week")
  )
  .addSubcommand(s =>
    s.setName("set-rate")
      .setDescription("Set how much % of the total crew commission pool a manager receives")
      .addUserOption(o => o.setName("user").setDescription("The manager to configure").setRequired(true))
      .addNumberOption(o =>
        o.setName("rate")
          .setDescription("Cut as a decimal — e.g. 0.20 = 20%")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(1)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  // ── view ──────────────────────────────────────────────────────────────────────
  if (sub === "view") {
    // Pull all managers/owners from user_roles
    const managersR = await db.execute(
      `SELECT p.discord_id, p.display_name, p.manager_override_rate
       FROM profiles p
       INNER JOIN user_roles ur ON p.discord_id = ur.discord_id
       WHERE ur.role IN ('manager','owner')`
    );

    // Calculate the mechanic+trainer commission pool for this week
    const ws = weekStart();
    const ordersR = await db.execute({
      sql: `SELECT o.labour, p.commission_rate
            FROM orders o
            JOIN profiles p ON o.mechanic_id = p.discord_id
            WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
      args: [ws]
    });

    // Also count people from guild roles (even with no orders)
    let crewCount = 0;
    if (interaction.guild) {
      const config = await getGuildConfig(interaction.guild.id);
      const roleIds = [
        ...splitRoleIds(config?.mechanic_role_id),
        ...splitRoleIds(config?.trainer_role_id)
      ];
      const seen = new Set<string>();
      for (const roleId of roleIds) {
        try {
          const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
          if (!role) continue;
          for (const [memberId] of role.members) seen.add(memberId);
        } catch { /* ignore */ }
      }
      crewCount = seen.size;
    }

    const grandCommission = ordersR.rows.reduce((sum, row) => {
      return sum + Number(row[0] ?? 0) * Number(row[1] ?? 0.3);
    }, 0);

    if (!managersR.rows.length) {
      await interaction.editReply({
        content:
          "❌ No managers/owners found in the database.\n" +
          "Use `/setrank` to assign manager roles first."
      });
      return;
    }

    const lines: string[] = [];
    let totalManagerCuts = 0;
    for (const row of managersR.rows) {
      const discordId    = String(row[0] ?? "");
      const name         = String(row[1] ?? "");
      const rate         = Number(row[2] ?? 0.20);
      const estimatedCut = grandCommission * rate;
      totalManagerCuts  += estimatedCut;
      lines.push(
        `**${name}** (<@${discordId}>)\n` +
        `  Rate: **${(rate * 100).toFixed(0)}%** of crew pool → Est. **${money(estimatedCut)}** this week`
      );
    }

    const embed = new EmbedBuilder()
      .setTitle("👔  Manager Commission Setup")
      .setColor(COLORS.primary)
      .setDescription(
        "The manager cut is automatically calculated as a % of the **total crew commission pool**.\n" +
        "It applies to **everyone** with Mechanic or Trainer roles — no manual selection needed.\n" +
        `Pay period: Week of \`${ws}\``
      )
      .addFields(
        { name: `👥 Crew (Mechanics + Trainers)`, value: `**${crewCount} people** in pool`, inline: true },
        { name: "💵 Crew Commission Pool (this week)", value: money(grandCommission), inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        { name: `🏆 Managers & Their Cuts`, value: lines.join("\n\n") || "None" },
        { name: "💰 Total Manager Cuts (this week)", value: `**${money(totalManagerCuts)}**`, inline: true },
        { name: "🧾 Total to Bill Company", value: `**${money(grandCommission + totalManagerCuts)}**`, inline: true }
      )
      .setFooter({ text: `${FOOTER}  ·  Use /manager set-rate to change rates` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── set-rate ─────────────────────────────────────────────────────────────────
  if (sub === "set-rate") {
    const target = interaction.options.getUser("user", true);
    const rate   = interaction.options.getNumber("rate", true);

    const profile = await getProfile(target.id);
    if (!profile) {
      await interaction.editReply({ content: `❌ <@${target.id}> doesn't have a profile yet. They need to be registered with \`/setrank\` first.` });
      return;
    }

    const oldRate = profile.manager_override_rate;
    await db.execute({
      sql: "UPDATE profiles SET manager_override_rate = ? WHERE discord_id = ?",
      args: [rate, target.id]
    });

    // Estimate their earnings based on this week's crew pool
    const ws = weekStart();
    const ordersR = await db.execute({
      sql: `SELECT o.labour, p.commission_rate
            FROM orders o
            JOIN profiles p ON o.mechanic_id = p.discord_id
            WHERE o.status IN ('complete','approved') AND DATE(o.created_at) >= ?`,
      args: [ws]
    });
    const grandCommission = ordersR.rows.reduce((sum, row) => {
      return sum + Number(row[0] ?? 0) * Number(row[1] ?? 0.3);
    }, 0);

    const embed = new EmbedBuilder()
      .setTitle("👔  Manager Commission Updated")
      .setColor(COLORS.approved)
      .addFields(
        { name: "Manager",   value: `<@${target.id}> — ${profile.display_name}`, inline: false },
        { name: "Old Rate",  value: `${(oldRate * 100).toFixed(0)}%`, inline: true },
        { name: "New Rate",  value: `${(rate * 100).toFixed(0)}%`,    inline: true },
        { name: "Applies To", value: "All Mechanics + Trainers (everyone with those roles)", inline: false },
        { name: "Est. Earnings This Week", value: money(grandCommission * rate), inline: true },
        { name: "Crew Pool This Week",     value: money(grandCommission),         inline: true }
      )
      .setDescription(
        `✅ Rate saved. On payday, **${profile.display_name}** will automatically receive **${(rate * 100).toFixed(0)}%** ` +
        `of the total mechanic + trainer commission pool — no manual selection required.`
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Log to log channel
    try {
      if (!interaction.guild) return;
      const config = await getGuildConfig(interaction.guild.id);
      if (!config?.log_channel_id) return;
      const ch = await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null);
      if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed] });
    } catch { /* ignore */ }
  }
}
