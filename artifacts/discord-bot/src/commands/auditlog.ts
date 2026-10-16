import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { requireRole } from "../lib/roles.js";
import { getRecentAudit, getRecentErrors } from "../lib/eventLog.js";
import { money } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("auditlog")
  .setDescription("View recent bot activity and errors (manager+)")
  .addSubcommand(sub =>
    sub.setName("recent").setDescription("Recent orders, clock events, payroll and config changes")
      .addStringOption(o => o.setName("kind").setDescription("Filter by event type").setRequired(false)
        .addChoices(
          { name: "Orders created", value: "order_created" },
          { name: "Orders completed", value: "order_completed" },
          { name: "Orders cancelled", value: "order_cancelled" },
          { name: "Clock in", value: "clock_in" },
          { name: "Clock out", value: "clock_out" },
          { name: "Auto clock-out", value: "auto_clock_out" },
          { name: "Payouts", value: "payout_processed" },
          { name: "Pay adjustments", value: "pay_adjusted" },
          { name: "New week", value: "new_week" },
          { name: "LOA submitted", value: "loa_submitted" },
          { name: "LOA approved", value: "loa_approved" },
          { name: "LOA denied", value: "loa_denied" },
          { name: "Crew changes", value: "crew_changed" },
          { name: "Panels refreshed", value: "panels_refreshed" },
        ))
      .addUserOption(o => o.setName("user").setDescription("Only this person").setRequired(false))
      .addIntegerOption(o => o.setName("count").setDescription("How many rows (1-25, default 15)").setMinValue(1).setMaxValue(25).setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("errors").setDescription("Recent bot errors with the command that caused them")
  );

function unix(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();

  if (sub === "errors") {
    const rows = await getRecentErrors(10);
    const embed = new EmbedBuilder().setTitle("🛠️ Recent bot errors").setColor(0xed4245);
    embed.setDescription(rows.length
      ? rows.map(r => `<t:${unix(r.ts)}:R> **${r.scope}**${r.command ? ` \`${r.command.slice(0, 40)}\`` : ""}\n${r.message.slice(0, 150)}`).join("\n\n").slice(0, 4000)
      : "No errors recorded. 🎉");
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const rows = await getRecentAudit({
    guildId: interaction.guildId ?? undefined,
    kind: interaction.options.getString("kind") ?? undefined,
    userId: interaction.options.getUser("user")?.id,
    limit: interaction.options.getInteger("count") ?? 15,
  });
  const lines = rows.map(r => {
    const who = r.userName ?? (r.userId ? `<@${r.userId}>` : "system");
    const bits = [
      r.orderNumber ? `**${r.orderNumber}**` : null,
      r.amount != null ? money(r.amount) : null,
      r.detail ? r.detail.slice(0, 80) : null,
    ].filter(Boolean).join(" · ");
    return `<t:${unix(r.ts)}:R> \`${r.kind}\` ${who}${bits ? ` — ${bits}` : ""}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("📜 Audit log")
    .setColor(0x5865f2)
    .setDescription(lines.length ? lines.join("\n").slice(0, 4000) : "Nothing logged yet.");
  await interaction.editReply({ embeds: [embed] });
}
