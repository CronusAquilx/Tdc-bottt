import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel
} from "discord.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export async function postOrderPanel(channel: TextChannel, mechanicId: string, displayName: string, commissionRate: number) {
  const panelEmbed = new EmbedBuilder()
    .setTitle("🏁  TOKYO DRIFT CUSTOMS")
    .setColor(0xe5342b)
    .setDescription(
      `**Welcome, ${displayName}.**\n\n` +
      "This is your personal sales channel. Start a new order below, or clock in when your shift begins.\n\n" +
      `> 💵 Your commission rate: **${(commissionRate * 100).toFixed(0)}% of labour**`
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("order:newpanel")
      .setLabel("📋  New Order")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("clockin:panel")
      .setLabel("🟢  Clock In")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("clockout:panel")
      .setLabel("🔴  Clock Out")
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({ embeds: [panelEmbed], components: [row] });
  try { await msg.pin(); } catch { /* ignore */ }
  return msg;
}
