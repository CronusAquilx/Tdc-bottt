import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder , MessageFlags} from "discord.js";
import { getUserRole } from "../db.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show available commands based on your role");

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = await getUserRole(interaction.user.id);

  const embed = new EmbedBuilder()
    .setTitle("🏁  TOKYO DRIFT CUSTOMS  ·  COMMANDS")
    .setColor(COLORS.primary)
    .setFooter({ text: FOOTER })
    .setTimestamp();

  if (!role) {
    embed
      .setDescription("You don't have a role assigned yet.\nAsk an **Owner** or **Manager** to add you with `/crew add`.")
      .addFields({ name: "No access", value: "Contact Lu, Phoenix, or Sierra to get set up." });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const hierarchy: Record<string, number> = { owner: 4, manager: 3, trainer: 2, mechanic: 1 };
  const level = hierarchy[role] ?? 0;

  const sections: { name: string; value: string }[] = [];

  // Mechanic+ (level 1+)
  if (level >= 1) {
    sections.push({
      name: "🔩  MECHANIC COMMANDS",
      value: [
        "`/order new` — Start a new customer order in your sales channel",
        "`/order list` — View your orders",
        "`/mysales` — Your personal sales dashboard & commission summary",
        "`/payout` — Check your total unpaid commission",
        "`/clock in` — Clock in to start your shift",
        "`/clock out` — Clock out and end your shift",
        "`/help` — This menu"
      ].join("\n")
    });
  }

  // Trainer+ (level 2+)
  if (level >= 2) {
    sections.push({
      name: "📚  TRAINER COMMANDS",
      value: [
        "`/crew view` — View crew roster",
        "`/job post` — Post a job listing",
        "`/job list` — View active job listings"
      ].join("\n")
    });
  }

  // Manager+ (level 3+)
  if (level >= 3) {
    sections.push({
      name: "🔧  MANAGER COMMANDS",
      value: [
        "`/order list` — View **all** orders across the shop",
        "`/crew add` — Add a new member to the crew",
        "`/crew remove` — Remove a crew member",
        "`/crew list` — Full crew roster with stats"
      ].join("\n")
    });
  }

  // Owner (level 4)
  if (level >= 4) {
    sections.push({
      name: "👑  OWNER COMMANDS",
      value: [
        "`/pay` — Process weekly commission payout",
        "`/crew commission` — Adjust a mechanic's commission rate",
        "`/settings` — View catalog & bot settings",
        "`/setup roles` — Map Discord roles to bot permission levels",
        "`/setup sales-channel` — Create a mechanic's personal sales channel",
        "`/setup order-panel` — Pin the 'Create New Order' panel in sales channels",
        "`/setup timeclock-channel` — Create the shared timeclock channel",
        "`/setup orders-channel` — Set the fallback orders channel",
        "`/setup logs-channel` — Set the system logs channel",
        "`/setup jobs-channel` — Set the job postings channel",
        "`/setup archive-channel` — Set the archive channel",
        "`/setup status` — View current bot configuration"
      ].join("\n")
    });
  }

  const roleLabel: Record<string, string> = {
    owner: "👑 Owner",
    manager: "🔧 Manager",
    trainer: "📚 Trainer",
    mechanic: "🔩 Mechanic"
  };

  embed.setDescription(`Your role: **${roleLabel[role] ?? role}**\nShowing all commands available to you.`);
  for (const s of sections) embed.addFields(s);

  await interaction.editReply({ embeds: [embed] });
}
