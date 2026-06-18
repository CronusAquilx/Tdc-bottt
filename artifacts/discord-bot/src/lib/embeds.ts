import { EmbedBuilder } from "discord.js";
import type { Order, Payout } from "../types.js";

export const COLORS = {
  primary: 0xe5342b,
  approved: 0x10b981,
  rejected: 0xef4444,
  submitted: 0x3b82f6,
  draft: 0x6b7280,
  dark: 0x1f2937,
  paid: 0x10b981
} as const;

export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    draft: "📝",
    submitted: "📋",
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
    approved: COLORS.approved,
    paid: COLORS.paid,
    rejected: COLORS.rejected,
    archived: COLORS.draft
  };
  return map[status] ?? COLORS.primary;
}

function footer(extra?: string): { text: string } {
  return { text: `Tokyo Drift Customs${extra ? ` | ${extra}` : ""}` };
}

export function buildOrderEmbed(
  order: Order,
  mechanicName: string,
  approverName?: string,
  commissionRate = 0.4
): EmbedBuilder {
  const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items as unknown as string);
  const commission = order.labour * commissionRate;

  const grouped: Record<string, string[]> = {};
  for (const item of items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(`${item.label} — ${money(item.price)}`);
  }

  const workDone = Object.entries(grouped)
    .map(([cat, list]) => `**${cat}:** ${list.join(", ")}`)
    .join("\n") || "_No items added_";

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(order.status)} Order ${order.status.charAt(0).toUpperCase() + order.status.slice(1)} · ${order.order_number}`)
    .setColor(statusColor(order.status))
    .addFields(
      { name: "Mechanic", value: mechanicName, inline: true },
      { name: "Status", value: order.status.toUpperCase(), inline: true },
      { name: "Date", value: new Date(order.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), inline: true },
      { name: "Customer Total", value: money(order.total), inline: true },
      { name: "Parts Cost", value: money(order.parts_cost), inline: true },
      { name: "Labour", value: money(order.labour), inline: true },
      { name: `Commission (${(commissionRate * 100).toFixed(0)}%)`, value: money(commission), inline: true }
    );

  if (order.approved_at) {
    embed.addFields({
      name: "Approved",
      value: new Date(order.approved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      inline: true
    });
  }
  if (approverName) {
    embed.addFields({ name: "Approved By", value: approverName, inline: true });
  }

  embed.addFields({ name: "Work Done", value: workDone.slice(0, 1024) });

  if (order.notes) {
    embed.addFields({ name: "Notes", value: order.notes.slice(0, 1024) });
  }
  if (order.rejected_reason) {
    embed.addFields({ name: "Rejection Reason", value: order.rejected_reason });
  }

  embed.setFooter(footer(approverName ? `Approved by: ${approverName}` : undefined));
  embed.setTimestamp();
  return embed;
}

export function buildPayoutEmbed(
  payout: Payout,
  mechanicName: string,
  processedBy: string,
  weekEnd: string,
  commissionRate = 0.4
): EmbedBuilder {
  const labour = commissionRate > 0 ? payout.amount / commissionRate : 0;

  return new EmbedBuilder()
    .setTitle(`💸 Weekly Payout · ${mechanicName}`)
    .setColor(COLORS.paid)
    .addFields(
      { name: "Week", value: `${payout.week_start} – ${weekEnd}`, inline: true },
      { name: "Paid", value: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Orders Completed", value: String(payout.order_count), inline: true },
      { name: "Total Revenue", value: money(labour), inline: true },
      { name: "Hours Worked", value: `${payout.hours_worked.toFixed(1)} hrs`, inline: true },
      { name: "Commission Rate", value: `${(commissionRate * 100).toFixed(0)}%`, inline: true },
      { name: "Commission Earned", value: money(payout.amount), inline: true },
      { name: "Invoice Count", value: String(payout.invoice_count), inline: true },
      { name: "💰 Total Payout", value: `**${money(payout.amount)}**` }
    )
    .setFooter({ text: `Tokyo Drift Customs | Processed by: ${processedBy}` })
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
  const ordTarget = 15;
  const ordPct = Math.min(Math.round((weekOrders / ordTarget) * 20), 20);
  const ordBar = "█".repeat(ordPct) + "░".repeat(20 - ordPct);

  return new EmbedBuilder()
    .setTitle(`📊 Sales Dashboard · ${mechanicName}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Status", value: `${statusEmoji(status)} ${status.replace("_", " ").toUpperCase()}`, inline: true },
      { name: "Hours This Week", value: `${weekHours.toFixed(1)} hrs`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Orders Today", value: String(todayOrders), inline: true },
      { name: "Revenue Today", value: money(todayRevenue), inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "This Week", value: `${weekOrders} orders · ${money(weekRevenue)} · ${weekHours.toFixed(1)} hrs`, inline: false },
      { name: "Commission Earned", value: money(weekCommission), inline: true },
      { name: "YTD", value: `${ytdOrders} orders · ${money(ytdRevenue)} · ${money(ytdCommission)} commission`, inline: false },
      {
        name: "Progress",
        value: `Revenue: \`${revBar}\` ${money(weekRevenue)} / ${money(weeklyTarget)}\nOrders:  \`${ordBar}\` ${weekOrders} / ${ordTarget}`
      }
    )
    .setFooter({ text: "Tokyo Drift Customs" })
    .setTimestamp();
}

export function buildAnalyticsEmbed(
  title: string,
  topPerformer: string,
  topPerformerOrders: number,
  topPerformerRevenue: number,
  avgOrderValue: number,
  totalOrders: number,
  totalRevenue: number,
  totalCommission: number,
  teamHours: number,
  mechanicStats: { name: string; orders: number; max: number }[]
): EmbedBuilder {
  const maxOrders = Math.max(...mechanicStats.map(m => m.orders), 1);
  const bars = mechanicStats
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 8)
    .map(m => {
      const filled = Math.round((m.orders / maxOrders) * 12);
      const bar = "█".repeat(filled) + "░".repeat(12 - filled);
      return `\`${m.name.padEnd(14).slice(0, 14)}\` ${bar} (${m.orders})`;
    })
    .join("\n");

  return new EmbedBuilder()
    .setTitle(`📈 ${title}`)
    .setColor(COLORS.primary)
    .addFields(
      { name: "Top Performer", value: `${topPerformer} (${topPerformerOrders} orders, ${money(topPerformerRevenue)})`, inline: false },
      { name: "Avg Order Value", value: money(avgOrderValue), inline: true },
      { name: "Total Orders", value: String(totalOrders), inline: true },
      { name: "Total Revenue", value: money(totalRevenue), inline: true },
      { name: "Total Commission", value: money(totalCommission), inline: true },
      { name: "Team Hours", value: `${teamHours.toFixed(1)} hrs`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Orders per Mechanic", value: bars || "_No data_" }
    )
    .setFooter(footer(`Generated: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`))
    .setTimestamp();
}

export function buildJobEmbed(title: string, body: string, postedBy: string, expiresAt?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🔧 ${title}`)
    .setColor(COLORS.primary)
    .setDescription(body)
    .addFields(
      { name: "Posted", value: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), inline: true },
      { name: "Posted By", value: postedBy, inline: true }
    );

  if (expiresAt) {
    embed.addFields({ name: "Expires", value: expiresAt, inline: true });
  }

  embed.setFooter(footer()).setTimestamp();
  return embed;
}

export function buildTimeclockEmbed(
  mechanicName: string,
  clockIn: string,
  clockOut: string | null,
  durationMins: number,
  status: string,
  notes: string | null
): EmbedBuilder {
  const inTime = new Date(clockIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const outTime = clockOut
    ? new Date(clockOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "Active";
  const hrs = Math.floor(durationMins / 60);
  const mins = Math.round(durationMins % 60);

  const embed = new EmbedBuilder()
    .setTitle(`⏰ ${clockOut ? "Clock Out" : "Clock In"} Confirmation · ${mechanicName}`)
    .setColor(status === "approved" ? COLORS.approved : COLORS.submitted)
    .addFields(
      { name: "Session", value: `${inTime} – ${outTime}`, inline: true },
      { name: "Duration", value: clockOut ? `${hrs}h ${mins}m` : "In Progress", inline: true },
      { name: "Status", value: `${statusEmoji(status)} ${status.charAt(0).toUpperCase() + status.slice(1)}`, inline: true }
    );

  if (notes) {
    embed.addFields({ name: "Notes", value: notes });
  }

  embed.setFooter(footer(status === "pending" ? "Awaiting Approval" : undefined)).setTimestamp();
  return embed;
}
