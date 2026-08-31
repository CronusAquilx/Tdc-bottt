import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel
} from "discord.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";
const PANEL_TITLE = "🏁  TOKYO DRIFT CUSTOMS";

function buildPanelEmbed(displayName: string, commissionRate: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setColor(0xe5342b)
    .setDescription(
      `**Welcome, ${displayName}.**\n\n` +
      "This is your personal sales channel. Start a new order below.\n\n" +
      `> 💵 Your commission rate: **${(commissionRate * 100).toFixed(0)}% of labour**\n\n` +
      "> ⏰ **Clock in and out using the dedicated clock panel channel.**"
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function buildPanelRow(mechanicId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("order:newpanel")
      .setLabel("📋  New Order")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`orderpay:start:${mechanicId}`)
      .setLabel("💸  Pay All My Orders")
      .setStyle(ButtonStyle.Primary),
  );
}

export async function postOrderPanel(
  channel: TextChannel,
  mechanicId: string,
  displayName: string,
  commissionRate: number
): Promise<{ message: any; pinned: boolean; updated: boolean }> {
  const embed = buildPanelEmbed(displayName, commissionRate);
  const row = buildPanelRow(mechanicId);

  // Try to find and edit an existing pinned panel from the bot so we update
  // the commission rate in place instead of posting a duplicate.
  try {
    const pins = await channel.messages.fetchPinned();
    const existing = pins.find(m =>
      m.author.id === channel.client.user?.id &&
      (m.embeds[0]?.title?.includes("TOKYO DRIFT CUSTOMS") ?? false)
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] });
      return { message: existing, pinned: true, updated: true };
    }
  } catch { /* ignore — channel may not allow pin fetch */ }

  // No existing panel found — post a new one and pin it.
  const msg = await channel.send({ embeds: [embed], components: [row] });
  let pinned = false;
  try {
    await msg.pin();
    pinned = true;
  } catch { /* no ManageMessages permission */ }
  return { message: msg, pinned, updated: false };
}
