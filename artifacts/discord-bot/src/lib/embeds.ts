import { EmbedBuilder } from "discord.js";
import type { Order, Payout } from "../types.js";

export const COLORS = {
  primary: 0xe5342b,
  approved: 0x10b981,
  rejected: 0xef4444,
  submitted: 0x3b82f6,
  complete: 0xe5342b,
  draft: 0x6b7280,
  dark: 0x111111,
  paid: 0x10b981
} as const;

export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    draft: "📝",
    submitted: "📋",
    complete: "✅",
    approved: "✅",
    paid: "💸",
    rejected: "❌",
    archived: "🗃️",
    pending: "⏳",
    online: "🟢",
    offline: "⚫",
    on_break: "🟡"
  };
  return map[status] ?? "❓";
}

export function statusColor(status: string): number {
  const map: Record<string, number> = {
    draft: COLORS.draft,
    submitted: COLORS.submitted,
    complete: COLORS.primary,
    approved: COLORS.approved,
    paid: COLORS.paid,
    rejected: COLORS.rejected,
    archived: COLORS.dark
  };
  return map[status] ?? COLORS.primary;
}

const FOOTER_TEXT = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export function buildOrderEmbed(
  order: Order,
  mechanicName: string,
  commissionRate = 0.3
): EmbedBuilder {
  const items: OrderItem[] = Array.isArray(order.items) ? order.items : [];
  const commission = order.labour * commissionRate;

  const statusLabel: Record<string, string> = {
    draft: "📝 DRAFT",
    complete: "✅ COMPLETE",
    submitted: "📋 SUBMITTED",
    approved: "✅ APPROVED",
    paid: "💸 PAID",
    rejected: "❌ REJECTED",
    archived: "🗃️ ARCHIVED"
  };

  const itemLines = items.length
    ? items.map(i => `> **${i.label}** — ${money(i.price)}`).join("\n")
    : "> _No services added_";

  const dateTs = Math.floor(new Date(order.created_at).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`🏁  ${order.order_number}`)
    .setColor(statusColor(order.status))
    .addFields(
      { name: "Mechanic", value: mechanicName, inline: true },
      { name: "Status", value: statusLabel[order.status] ?? order.status.toUpperCase(), inline: true },
      { name: "Date", value: `<t:${dateTs}:d>`, inline: true },
      {
        name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        value: itemLines.slice(0, 1024),
        inline: false
      },
      { name: "🔩 Parts Cost", value: money(order.parts_cost), inline: true },
      { name: "🔧 Labour", value: money(order.labour), inline: true },
      { name: "💰 Customer Total", value: money(order.total), inline: true }
    );

  if (order.status !== "draft") {
    embed.addFields({
      name: `💵  YOUR COMMISSION  (${(commissionRate * 100).toFixed(0)}%)`,
      value: `## ${money(commission)}`,
      inline: false
    });
  }

  if (order.notes) {
    embed.addFields({ name: "📝 Notes", value: order.notes.slice(0, 512), inline: false });
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
    ? items.map(i => `> **${i.label}** — ${money(i.price)}`).join("\n")
    : "> _No services yet — select a category below_";

  return new EmbedBuilder()
    .setTitle(`📝  DRAFT  ·  ${order.order_number}`)
    .setColor(COLORS.draft)
    .setDescription("Select services by category. Labour is auto-suggested — edit it if needed.")
    .addFields(
      {
        name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        value: itemLines.slice(0, 1024),
        inline: false
      },
      { name: "🔩 Parts", value: money(order.parts_cost), inline: true },
      { name: "🔧 Labour (suggested)", value: money(order.labour), inline: true },
      { name: "💰 Total", value: money(order.total), inline: true },
      { name: `💵 Est. Commission (${(commissionRate * 100).toFixed(0)}%)`, value: money(commission), inline: false }
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildClockInEmbed(mechanicName: string, clockInTime: string): EmbedBuilder {
  const unixTs = Math.floor(new Date(clockInTime).getTime() / 1000);
  return new EmbedBuilder()
    .setTitle("🟢  CLOCKED IN")
    .setColor(0x10b981)
    .setDescription(`**${mechanicName}** is now on shift`)
    .addFields(
      { name: "Started", value: `<t:${unixTs}:F>`, inline: true },
      { name: "Live Duration", value: `<t:${unixTs}:R>`, inline: true }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Session in progress" })
    .setTimestamp();
}

export function buildClockOutEmbed(
  mechanicName: string,
  clockInTime: string,
  clockOutTime: string,
  durationMins: number
): EmbedBuilder {
  const inTs = Math.floor(new Date(clockInTime).getTime() / 1000);
  const outTs = Math.floor(new Date(clockOutTime).getTime() / 1000);
  const hrs = Math.floor(durationMins / 60);
  const mins = Math.round(durationMins % 60);
  return new EmbedBuilder()
    .setTitle("🔴  SHIFT COMPLETE")
    .setColor(COLORS.primary)
    .setDescription(`**${mechanicName}** clocked out`)
    .addFields(
      { name: "Clocked In", value: `<t:${inTs}:F>`, inline: true },
      { name: "Clocked Out", value: `<t:${outTs}:F>`, inline: true },
      { name: "Total Time", value: `**${hrs}h ${mins}m**`, inline: true }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Session complete" })
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
    .addFields(
      { name: "Week", value: `${payout.week_start} – ${weekEnd}`, inline: true },
      { name: "Paid", value: `<t:${Math.floor(Date.now() / 1000)}:d>`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Orders Completed", value: String(payout.order_count), inline: true },
      { name: "Total Revenue", value: money(labour), inline: true },
      { name: "Hours Worked", value: `${payout.hours_worked.toFixed(1)} hrs`, inline: true },
      { name: "Commission Rate", value: `${(commissionRate * 100).toFixed(0)}%`, inline: true },
      { name: "💰 Total Payout", value: `## ${money(payout.amount)}` }
    )
    .setFooter({ text: `東京ドリフトカスタム  ·  Processed by: ${processedBy}` })
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

  return new EmbedBuilder()
    .setTitle(`📊  MY SALES  ·  ${mechanicName}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Status", value: `${statusEmoji(status)} ${status.replace("_", " ").toUpperCase()}`, inline: true },
      { name: "Hours This Week", value: `${weekHours.toFixed(1)} hrs`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Today", value: `${todayOrders} orders · ${money(todayRevenue)}`, inline: true },
      { name: "This Week", value: `${weekOrders} orders · ${money(weekRevenue)}`, inline: true },
      { name: "YTD", value: `${ytdOrders} orders · ${money(ytdRevenue)}`, inline: true },
      { name: "💵 Commission This Week", value: money(weekCommission), inline: true },
      { name: "💵 Commission YTD", value: money(ytdCommission), inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Weekly Progress", value: `\`${revBar}\` ${money(weekRevenue)} / ${money(weeklyTarget)}` }
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildJobEmbed(title: string, body: string, postedBy: string, expiresAt?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🔧  ${title}`)
    .setColor(COLORS.primary)
    .setDescription(body)
    .addFields(
      { name: "Posted By", value: postedBy, inline: true },
      { name: "Posted", value: `<t:${Math.floor(Date.now() / 1000)}:d>`, inline: true }
    );
  if (expiresAt) embed.addFields({ name: "Expires", value: expiresAt, inline: true });
  embed.setFooter({ text: FOOTER_TEXT }).setTimestamp();
  return embed;
}
