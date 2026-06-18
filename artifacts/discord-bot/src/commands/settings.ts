import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getSetting, setSetting } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Bot settings (owner only)")
  .addSubcommand(s => s.setName("view").setDescription("View current settings"))
  .addSubcommand(s =>
    s.setName("commission")
      .setDescription("Set default commission rate")
      .addNumberOption(o => o.setName("rate").setDescription("Rate 0.0 – 1.0").setRequired(true).setMinValue(0).setMaxValue(1))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "owner"))) return;
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === "view") {
    const [commDefault, catalogStr] = await Promise.all([getSetting("commission_default"), getSetting("parts_catalog")]);
    const catalog = JSON.parse(catalogStr ?? "{}");
    const categories: string[] = catalog.categories ?? [];
    const items: any[] = catalog.items ?? [];
    const embed = new EmbedBuilder()
      .setTitle("⚙️ Shop Settings — Tokyo Drift Customs")
      .setColor(COLORS.dark)
      .addFields(
        { name: "Default Commission Rate", value: `${(parseFloat(commDefault ?? "0.4") * 100).toFixed(0)}%`, inline: true },
        { name: "Categories", value: categories.join(", ") || "None" },
        { name: "Parts Catalog", value: `${items.length} items across ${categories.length} categories` }
      )
      .setFooter({ text: "Tokyo Drift Customs" }).setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("settings:viewcatalog").setLabel("📋 View Full Catalog").setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (sub === "commission") {
    const rate = interaction.options.getNumber("rate", true);
    await setSetting("commission_default", String(rate));
    await interaction.editReply({ content: `✅ Default commission rate updated to **${(rate * 100).toFixed(0)}%**.` });
  }
}
