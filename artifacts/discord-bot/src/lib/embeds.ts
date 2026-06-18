import { EmbedBuilder } from "discord.js";
import type { Order, Payout } from "../types.js";

export const COLORS = {
  primary:   0xe5342b,
  approved:  0x10b981,
  rejected:  0xef4444,
  submitted: 0x3b82f6,
  complete:  0xe5342b,
  draft:     0x5865f2,
  dark:      0x0d0d0d,
  paid:      0x10b981,
  warning:   0xf59e0b,
  gold:      0xffd700,
} as const;

export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    draft:     "📝",
    submitted: "📋",
    complete:  "✅",
    approved:  "✅",
    paid:      "💸",
    rejected:  "❌",
    archived:  "🗃️",
    pending:   "⏳",
    online:    "🟢",
    offline:   "⚫",
    on_break:  "🟡"
  };
  return map[status] ?? "❓";
}

export function statusColor(status: string): number {
  const map: Record<string, number> = {
    draft:     COLORS.draft,
    submitted: COLORS.submitted,
    complete:  COLORS.primary,
    approved:  COLORS.approved,
    paid:      COLORS.paid,
    rejected:  COLORS.rejected,
    archived:  COLORS.dark
  };
  return map[status] ?? COLORS.primary;
}

const FOOTER_TEXT = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";
const DIVIDER = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";

export function buildOrderEmbed(
  order: Order,
  mechanicName: string,
  commissionRate = 0.3
): EmbedBuilder {
  const items: OrderItem[] = Array.isArray(order.items) ? order.items : [];
  const commission = order.labour * commissionRate;

  const statusLabel: Record<string, string> = {
    draft:     "📝 DRAFT",
    complete:  "✅ COMPLETE",
    submitted: "📋 SUBMITTED",
    approved:  "✅ APPROVED",
    paid:      "💸 PAID",
    rejected:  "❌ REJECTED",
    archived:  "🗃️ ARCHIVED"
  };

  const itemLines = items.length
    ? items.map(i => `\`${i.category.padEnd(16)}\` **${i.label}** — ${money(i.price)}`).join("\n")
    : "*No services added*";

  const dateTs = Math.floor(new Date(order.created_at).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`🏁  ORDER  ·  ${order.order_number}`)
    .setColor(statusColor(order.status))
    .setDescription(
      `**${statusLabel[order.status] ?? order.status.toUpperCase()}**\n` +
      `> **Mechanic:** ${mechanicName}\n` +
      `> **Date:** <t:${dateTs}:D>  ·  <t:${dateTs}:t>`
    )
    .addFields(
      {
        name: "🔧 Services",
        value: itemLines.slice(0, 1024),
        inline: false
      },
      { name: DIVIDER, value: "\u200b", inline: false },
      { name: "🔩 Parts Cost",        value: `\`${money(order.parts_cost)}\``, inline: true },
      { name: "⚙️ Labour",            value: `\`${money(order.labour)}\``,     inline: true },
      { name: "💰 Customer Total",    value: `**\`${money(order.total)}\`**`,   inline: true }
    );

  if (order.status !== "draft") {
    embed.addFields({
      name: `💵 YOUR CUT  ·  ${(commissionRate * 100).toFixed(0)}%`,
      value: `# ${money(commission)}`,
      inline: false
    });
  }

  if (order.notes) {
    embed.addFields({ name: "📋 Customer Notes", value: `> ${order.notes.slice(0, 512)}`, inline: false });
  }

  embed.setFooter({ text: FOOTER_TEXT }).setTimestamp();
  return embed;
}

interface OrderItem {
  label: string;
  price: number;
  cost: number;
  labour: number;
  category: string;
}

export function buildDraftEmbed(
  order: Order,
  commissionRate = 0.3
): EmbedBuilder {
  const items: OrderItem[] = Array.isArray(order.items) ? order.items : [];
  const commission = order.labour * commissionRate;

  const itemLines = items.length
    ? items.map(i => `\`${i.category.padEnd(16)}\` **${i.label}** — ${money(i.price)}`).join("\n")
    : "*No services added yet — pick a category below*";

  return new EmbedBuilder()
    .setTitle(`🔧  NEW ORDER  ·  ${order.order_number}`)
    .setColor(COLORS.draft)
    .setDescription("Pick services from the dropdown. Adjust labour if needed, then hit **Complete Order** when done.")
    .addFields(
      {
        name: "🛠️ Services Added",
        value: itemLines.slice(0, 1024),
        inline: false
      },
      { name: DIVIDER, value: "\u200b", inline: false },
      { name: "🔩 Parts",               value: `\`${money(order.parts_cost)}\``, inline: true },
      { name: "⚙️ Labour",              value: `\`${money(order.labour)}\``,     inline: true },
      { name: "💰 Total",               value: `**\`${money(order.total)}\`**`,  inline: true },
      { name: `💵 Est. Commission  ·  ${(commissionRate * 100).toFixed(0)}%`, value: `**${money(commission)}**`, inline: false }
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildClockInEmbed(mechanicName: string, clockInTime: string): EmbedBuilder {
  const unixTs = Math.floor(new Date(clockInTime).getTime() / 1000);
  return new EmbedBuilder()
    .setTitle("🟢  ON THE CLOCK")
    .setColor(0x10b981)
    .setDescription(`**${mechanicName}** just punched in and is ready to work.`)
    .addFields(
      { name: "⏱️ Started",       value: `<t:${unixTs}:t>  ·  <t:${unixTs}:D>`, inline: true },
      { name: "🔄 Session Timer", value: `<t:${unixTs}:R>`,                       inline: true }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Shift in progress" })
    .setTimestamp();
}

export function buildClockOutEmbed(
  mechanicName: string,
  clockInTime: string,
  clockOutTime: string,
  durationMins: number,
  ordersThisSession = 0
): EmbedBuilder {
  const inTs  = Math.floor(new Date(clockInTime).getTime()  / 1000);
  const outTs = Math.floor(new Date(clockOutTime).getTime() / 1000);
  const hrs  = Math.floor(durationMins / 60);
  const mins = Math.round(durationMins % 60);

  return new EmbedBuilder()
    .setTitle("🔴  SHIFT COMPLETE")
    .setColor(COLORS.primary)
    .setDescription(`**${mechanicName}** has clocked out.`)
    .addFields(
      { name: "🟢 Clocked In",    value: `<t:${inTs}:t>`,              inline: true },
      { name: "🔴 Clocked Out",   value: `<t:${outTs}:t>`,             inline: true },
      { name: "⏱️ Total Time",    value: `**${hrs}h ${mins}m**`,       inline: true },
      { name: "📋 Orders This Shift", value: `**${ordersThisSession}**`, inline: true }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Shift closed" })
    .setTimestamp();
}

export function buildTimeclockEmbed(
  mechanicName: string,
  clockIn: string,
  clockOut: string | null,
  durationMins: number,
  status: string,
  notes: string | null
): EmbedBuilder {
  if (clockOut) {
    return buildClockOutEmbed(mechanicName, clockIn, clockOut, durationMins);
  }
  return buildClockInEmbed(mechanicName, clockIn);
}

export function buildPayoutEmbed(
  payout: Payout,
  mechanicName: string,
  processedBy: string,
  weekEnd: string,
  commissionRate = 0.3
): EmbedBuilder {
  const labour = commissionRate > 0 ? payout.amount / commissionRate : 0;

  return new EmbedBuilder()
    .setTitle(`💸  PAYOUT  ·  ${mechanicName}`)
    .setColor(COLORS.paid)
    .setDescription(`Payout processed for **${mechanicName}** — week of ${payout.week_start}`)
    .addFields(
      { name: "📅 Week",              value: `${payout.week_start} – ${weekEnd}`,   inline: true },
      { name: "✅ Paid",              value: `<t:${Math.floor(Date.now() / 1000)}:D>`, inline: true },
      { name: "\u200b",               value: "\u200b",                                 inline: true },
      { name: "📋 Orders",            value: `**${payout.order_count}**`,            inline: true },
      { name: "💰 Total Revenue",     value: `**${money(labour)}**`,                 inline: true },
      { name: "🕐 Hours Worked",      value: `**${payout.hours_worked.toFixed(1)} hrs**`, inline: true },
      { name: "📊 Commission Rate",   value: `**${(commissionRate * 100).toFixed(0)}%**`,  inline: true },
      { name: "💵 TOTAL PAYOUT",      value: `# ${money(payout.amount)}`,            inline: false }
    )
    .setFooter({ text: `東京ドリフトカスタム  ·  Processed by ${processedBy}` })
    .setTimestamp();
}

export function buildDashboardEmbed(
  mechanicName: string,
  status: string,
  todayOrders: number,
  todayRevenue: number,
  weekOrders: number,
  weekRevenue: number,
  weekHours: number,
  weekCommission: number,
  ytdOrders: number,
  ytdRevenue: number,
  ytdCommission: number,
  weeklyTarget = 50000
): EmbedBuilder {
  const revPct = Math.min(Math.round((weekRevenue / weeklyTarget) * 20), 20);
  const revBar = "█".repeat(revPct) + "░".repeat(20 - revPct);
  const pct = Math.round((weekRevenue / weeklyTarget) * 100);

  return new EmbedBuilder()
    .setTitle(`📊  SALES DASHBOARD  ·  ${mechanicName}`)
    .setColor(COLORS.primary)
    .setDescription(`**Status:** ${statusEmoji(status)} ${status.replace("_", " ").toUpperCase()}  ·  **${weekHours.toFixed(1)} hrs** this week`)
    .addFields(
      { name: "📅 Today",          value: `**${todayOrders}** orders\n${money(todayRevenue)}`,   inline: true },
      { name: "📆 This Week",      value: `**${weekOrders}** orders\n${money(weekRevenue)}`,     inline: true },
      { name: "📈 Year to Date",   value: `**${ytdOrders}** orders\n${money(ytdRevenue)}`,       inline: true },
      { name: "💵 Commission (Week)", value: `**${money(weekCommission)}**`,                     inline: true },
      { name: "💵 Commission (YTD)",  value: `**${money(ytdCommission)}**`,                     inline: true },
      { name: "\u200b",           value: "\u200b",                                               inline: true },
      { name: `🎯 Weekly Target  ·  ${pct}%`, value: `\`${revBar}\`\n${money(weekRevenue)} / ${money(weeklyTarget)}`, inline: false }
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildJobEmbed(title: string, body: string, postedBy: string, expiresAt?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🔧  NOW HIRING  ·  ${title}`)
    .setColor(COLORS.gold)
    .setDescription(body)
    .addFields(
      { name: "📋 Position",  value: title,    inline: true },
      { name: "👤 Posted By", value: postedBy, inline: true },
      { name: "🕐 Posted",    value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
    );
  if (expiresAt) embed.addFields({ name: "⏰ Expires", value: expiresAt, inline: true });
  embed.setFooter({ text: "東京ドリフトカスタム  ·  Join the crew" }).setTimestamp();
  return embed;
}

export function buildAdminPanelEmbed(config: {
  orders_channel_id: string | null;
  jobs_channel_id: string | null;
  log_channel_id: string | null;
  archive_channel_id: string | null;
  timeclock_channel_id: string | null;
  owner_role_id: string | null;
  manager_role_id: string | null;
  trainer_role_id: string | null;
  mechanic_role_id: string | null;
} | null): EmbedBuilder {
  const ch = (id: string | null | undefined) => id ? `<#${id}>` : "`❌ Not set`";
  const ro = (id: string | null | undefined) => id ? `<@&${id}>` : "`❌ Not set`";

  return new EmbedBuilder()
    .setTitle("⚙️  TDC ADMIN PANEL")
    .setColor(COLORS.dark)
    .setDescription(
      "**Tokyo Drift Customs — Server Control Panel**\n" +
      "Use the buttons below to configure channels, roles, and more.\n" +
      "Only owners, managers, and trainers can interact with this panel."
    )
    .addFields(
      { name: DIVIDER, value: "**📡 Channels**", inline: false },
      { name: "📋 Orders",    value: ch(config?.orders_channel_id),    inline: true },
      { name: "🕐 Timeclock", value: ch(config?.timeclock_channel_id), inline: true },
      { name: "💼 Jobs",      value: ch(config?.jobs_channel_id),      inline: true },
      { name: "📜 Logs",      value: ch(config?.log_channel_id),       inline: true },
      { name: "🗃️ Archive",  value: ch(config?.archive_channel_id),   inline: true },
      { name: "\u200b",       value: "\u200b",                          inline: true },
      { name: DIVIDER, value: "**🎭 Roles**", inline: false },
      { name: "👑 Owner",     value: ro(config?.owner_role_id),    inline: true },
      { name: "🔧 Manager",   value: ro(config?.manager_role_id),  inline: true },
      { name: "📚 Trainer",   value: ro(config?.trainer_role_id),  inline: true },
      { name: "🔩 Mechanic",  value: ro(config?.mechanic_role_id), inline: true },
      { name: "\u200b",       value: "\u200b",                     inline: true },
      { name: "\u200b",       value: "\u200b",                     inline: true },
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();
}
