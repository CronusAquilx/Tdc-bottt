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
  raffle:    0x9b59b6,
  loa:       0xf39c12,
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

export function buildOrderEmbed(
  order: Order,
  mechanicName: string,
  weekCommission = 0,
  commissionRate = 0.3,
  crewCutInfo?: { amount: number; rate: number; label: string }
): EmbedBuilder {
  const items: OrderItem[] = Array.isArray(order.items) ? order.items : [];

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
    ? items.map(i => `> **${i.label}** · ${money(i.price)}`).join("\n")
    : "*No services added*";

  const dateTs = Math.floor(new Date(order.created_at).getTime() / 1000);
  const noteBlock = order.notes ? `\n📋 **Notes:** ${order.notes.slice(0, 300)}` : "";
  const customerBlock = order.customer_name ? `\n👤 **Customer:** ${order.customer_name}` : "";

  const thisOrderCommission = Math.round(order.labour * commissionRate);
  const commissionPct = (commissionRate * 100).toFixed(0);

  const embed = new EmbedBuilder()
    .setTitle(`🏁  ${order.order_number}  ·  ${statusLabel[order.status] ?? order.status.toUpperCase()}`)
    .setColor(statusColor(order.status))
    .setDescription(
      `**Mechanic:** ${mechanicName}  ·  <t:${dateTs}:D>${customerBlock}${noteBlock}`
    )
    .addFields(
      { name: "🔧 Services", value: itemLines.slice(0, 1024), inline: false },
      { name: "🔩 Parts",    value: money(order.parts_cost), inline: true },
      { name: "⚙️ Labour",  value: money(order.labour),     inline: true },
      {
        name: "💰 Total",
        value: order.customer_total_override != null
          ? `**${money(order.customer_total_override)}** ✏️\n-# Calculated: ${money(order.total)}`
          : `**${money(order.total)}**`,
        inline: true
      },
      {
        name:  "💵 Commission (This Order)",
        value: `**${money(thisOrderCommission)}**\n-# ${commissionPct}% of labour`,
        inline: true
      },
      {
        name:  "📊 Commission (Pay Period)",
        value: `**${money(Math.round(weekCommission))}**\n-# All orders since last pay`,
        inline: true
      }
    );

  if (crewCutInfo) {
    const crewPct = (crewCutInfo.rate * 100).toFixed(0);
    const totalPayout = Math.round(weekCommission) + Math.round(crewCutInfo.amount);
    embed.addFields(
      {
        name:  `👥 ${crewCutInfo.label} (Pay Period)`,
        value: `**${money(Math.round(crewCutInfo.amount))}**\n-# ${crewPct}% of crew labour`,
        inline: true
      },
      {
        name:  "💸 Total Payout (Pay Period)",
        value: `**${money(totalPayout)}**\n-# Order commission + Cut combined`,
        inline: true
      }
    );
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
  weekCommission = 0,
  commissionRate = 0.3,
  crewCutInfo?: { amount: number; rate: number; label: string }
): EmbedBuilder {
  const items: OrderItem[] = Array.isArray(order.items) ? order.items : [];

  const itemLines = items.length
    ? items.map(i => `> **${i.label}** · ${money(i.price)}`).join("\n")
    : "*No services yet — pick a category below*";

  const thisOrderCommission = Math.round(order.labour * commissionRate);
  const pct = (commissionRate * 100).toFixed(0);

  const summaryParts: string[] = [];
  if (order.parts_cost > 0) summaryParts.push(`Parts: ${money(order.parts_cost)}`);
  if (order.labour > 0)     summaryParts.push(`Labour: ${money(order.labour)}`);
  const summaryLine = summaryParts.length ? `\n-# ${summaryParts.join("  ·  ")}` : "";

  const displayTotal = order.customer_total_override ?? order.total;
  const totalLine = order.customer_total_override != null
    ? `**${money(displayTotal)}** ✏️\n-# Calculated: ${money(order.total)}`
    : `**${money(displayTotal)}**${summaryLine}`;

  const fields: any[] = [
    { name: "🛠️ Services", value: itemLines.slice(0, 1024), inline: false },
    {
      name: "💰 Customer Total",
      value: totalLine,
      inline: true
    },
    {
      name: "💵 Your Cut (This Order)",
      value: order.labour > 0
        ? `**${money(thisOrderCommission)}**\n-# ${pct}% of ${money(order.labour)} labour`
        : `*—*\n-# Set labour above`,
      inline: true
    },
  ];

  // Include this draft order's projected commission so the running total updates as items are added
  const projectedWeekCommission = weekCommission + thisOrderCommission;
  if (projectedWeekCommission > 0) {
    fields.push({
      name: "📊 Running Commission (Pay Period)",
      value: `**${money(Math.round(projectedWeekCommission))}**\n-# Includes this order's projected cut`,
      inline: true
    });
  }

  if (crewCutInfo) {
    const crewPct = (crewCutInfo.rate * 100).toFixed(0);
    const totalPayout = Math.round(weekCommission) + Math.round(crewCutInfo.amount);
    fields.push(
      {
        name: `👥 ${crewCutInfo.label} (Pay Period)`,
        value: crewCutInfo.amount > 0
          ? `**${money(Math.round(crewCutInfo.amount))}**\n-# ${crewPct}% of crew labour`
          : `**${money(0)}**\n-# ${crewPct}% — no crew orders yet`,
        inline: true
      },
      {
        name: "💸 Total Payout (Pay Period)",
        value: `**${money(totalPayout)}**\n-# Order commission + Cut combined`,
        inline: true
      }
    );
  }

  const draftCustomerLine = order.customer_name
    ? `👤 **Customer:** ${order.customer_name}\n`
    : "";

  return new EmbedBuilder()
    .setTitle(`📝  Draft Order  ·  ${order.order_number}`)
    .setColor(COLORS.draft)
    .setDescription(`${draftCustomerLine}Select a category below to add services. Hit **✅ Complete Order** when done.`)
    .addFields(...fields)
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
      { name: "🟢 Clocked In",        value: `<t:${inTs}:t>`,          inline: true },
      { name: "🔴 Clocked Out",        value: `<t:${outTs}:t>`,         inline: true },
      { name: "⏱️ Total Time",         value: `**${hrs}h ${mins}m**`,   inline: true },
      { name: "📋 Orders This Shift",  value: `**${ordersThisSession}**`, inline: true }
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
  if (clockOut) return buildClockOutEmbed(mechanicName, clockIn, clockOut, durationMins);
  return buildClockInEmbed(mechanicName, clockIn);
}

export function buildClockInPromptEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("⏰  Clock In Required")
    .setColor(COLORS.warning)
    .setDescription(
      "**You need to be clocked in before creating an order.**\n\n" +
      "Click the button below to clock in — your shift will start immediately and appear in the timeclock channel."
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." });
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
    .setTitle(`💸  Payout  ·  ${mechanicName}`)
    .setColor(COLORS.paid)
    .setDescription(`Payout processed for **${mechanicName}** — week of ${payout.week_start}`)
    .addFields(
      { name: "📅 Week",           value: `${payout.week_start} – ${weekEnd}`,          inline: true },
      { name: "✅ Paid",           value: `<t:${Math.floor(Date.now() / 1000)}:D>`,      inline: true },
      { name: "\u200b",            value: "\u200b",                                       inline: true },
      { name: "📋 Orders",         value: `**${payout.order_count}**`,                   inline: true },
      { name: "💰 Total Revenue",  value: `**${money(labour)}**`,                        inline: true },
      { name: "🕐 Hours Worked",   value: `**${payout.hours_worked.toFixed(1)} hrs**`,   inline: true },
      { name: "📊 Commission Rate",value: `**${(commissionRate * 100).toFixed(0)}%**`,   inline: true },
      { name: "💵 TOTAL PAYOUT",   value: `**${money(payout.amount)}**`,                 inline: false }
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
    .setTitle(`📊  Sales Dashboard  ·  ${mechanicName}`)
    .setColor(COLORS.primary)
    .setDescription(`**Status:** ${statusEmoji(status)} ${status.replace("_", " ").toUpperCase()}  ·  **${weekHours.toFixed(1)} hrs** this week`)
    .addFields(
      { name: "📅 Today",             value: `**${todayOrders}** orders\n${money(todayRevenue)}`,  inline: true },
      { name: "📆 This Week",         value: `**${weekOrders}** orders\n${money(weekRevenue)}`,    inline: true },
      { name: "📈 Year to Date",      value: `**${ytdOrders}** orders\n${money(ytdRevenue)}`,      inline: true },
      { name: "💵 Commission (Week)", value: `**${money(weekCommission)}**`,                        inline: true },
      { name: "💵 Commission (YTD)",  value: `**${money(ytdCommission)}**`,                        inline: true },
      { name: "\u200b",               value: "\u200b",                                             inline: true },
      { name: `🎯 Weekly Target  ·  ${pct}%`, value: `\`${revBar}\`\n${money(weekRevenue)} / ${money(weeklyTarget)}`, inline: false }
    )
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp();
}

export function buildJobEmbed(title: string, body: string, postedBy: string, expiresAt?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🔧  Now Hiring  ·  ${title}`)
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
  loa_channel_id?: string | null;
  raffle_channel_id?: string | null;
  owner_role_id: string | null;
  manager_role_id: string | null;
  trainer_role_id: string | null;
  mechanic_role_id: string | null;
} | null): EmbedBuilder {
  const ch = (id: string | null | undefined) => id ? `<#${id}>` : "`Not set`";
  const ro = (id: string | null | undefined) => id ? `<@&${id}>` : "`Not set`";

  return new EmbedBuilder()
    .setTitle("⚙️  TDC Admin Panel")
    .setColor(COLORS.dark)
    .setDescription(
      "**Tokyo Drift Customs — Server Control Panel**\n" +
      "Use the buttons below to configure channels, roles, and systems.\n" +
      "Only owners, managers, and trainers can interact with this panel."
    )
    .addFields(
      { name: "📡 Channels", value:
          `📋 Orders: ${ch(config?.orders_channel_id)}\n` +
          `⏰ Timeclock: ${ch(config?.timeclock_channel_id)}\n` +
          `💼 Jobs: ${ch(config?.jobs_channel_id)}\n` +
          `📜 Logs: ${ch(config?.log_channel_id)}\n` +
          `🗃️ Archive: ${ch(config?.archive_channel_id)}\n` +
          `🌴 LOA: ${ch(config?.loa_channel_id)}\n` +
          `🎰 Raffle: ${ch(config?.raffle_channel_id)}`,
        inline: true
      },
      { name: "🎭 Roles", value:
          `👑 Owner: ${ro(config?.owner_role_id)}\n` +
          `🔧 Manager: ${ro(config?.manager_role_id)}\n` +
          `📚 Trainer: ${ro(config?.trainer_role_id)}\n` +
          `🔩 Mechanic: ${ro(config?.mechanic_role_id)}`,
        inline: true
      }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
    .setTimestamp();
}

export function buildRaffleEmbed(raffle: {
  id: string;
  title: string;
  description: string;
  winner_count: number;
  ends_at: string | null;
  entry_count: number;
  status: string;
  prizes?: string[];
}): EmbedBuilder {
  const ts = raffle.ends_at ? Math.floor(new Date(raffle.ends_at).getTime() / 1000) : null;
  const prizes = raffle.prizes?.length ? raffle.prizes.map((p, i) => `${i + 1}. ${p}`).join("\n") : raffle.title;

  const statusLine = raffle.status === "active"
    ? (ts ? `⏰ Ends: <t:${ts}:R>  ·  <t:${ts}:F>` : "⏰ Ends when the owner starts the wheel")
    : raffle.status === "ended" ? "🏁 Raffle has ended"
    : "🎰 Spinning...";

  return new EmbedBuilder()
    .setTitle("🎰  RAFFLE  ·  Tokyo Drift Customs")
    .setColor(COLORS.raffle)
    .setDescription(
      `## ${raffle.title}\n\n${raffle.description}\n\n${statusLine}`
    )
    .addFields(
      { name: "🎁 Prize(s)",      value: prizes,                          inline: true },
      { name: "🏆 Winners",       value: `**${raffle.winner_count}**`,    inline: true },
      { name: "🎟️ Entries",      value: `**${raffle.entry_count}**`,     inline: true }
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Good luck! 🍀" })
    .setTimestamp();
}

export function buildLoaEmbed(loa: {
  mechanic_name: string;
  reason: string;
  start_date: string;
  return_date: string;
  notes?: string;
  status: string;
}): EmbedBuilder {
  const startTs  = Math.floor(new Date(loa.start_date).getTime() / 1000);
  const returnTs = Math.floor(new Date(loa.return_date).getTime() / 1000);

  const statusColors: Record<string, number> = { pending: COLORS.warning, approved: COLORS.approved, denied: COLORS.rejected };
  const statusLabels: Record<string, string> = { pending: "⏳ Pending", approved: "✅ Approved", denied: "❌ Denied" };

  return new EmbedBuilder()
    .setTitle(`🌴  Leave of Absence  ·  ${loa.mechanic_name}`)
    .setColor(statusColors[loa.status] ?? COLORS.loa)
    .setDescription(`**${loa.mechanic_name}** has submitted a Leave of Absence request.`)
    .addFields(
      { name: "📋 Status",       value: statusLabels[loa.status] ?? loa.status, inline: true },
      { name: "👤 Mechanic",     value: loa.mechanic_name,                       inline: true },
      { name: "\u200b",          value: "\u200b",                                inline: true },
      { name: "📅 Start Date",   value: `<t:${startTs}:D>  ·  <t:${startTs}:R>`,  inline: true },
      { name: "🔙 Return Date",  value: `<t:${returnTs}:D>  ·  <t:${returnTs}:R>`, inline: true },
      { name: "\u200b",          value: "\u200b",                                inline: true },
      { name: "📝 Reason",       value: loa.reason,                              inline: false },
      ...(loa.notes ? [{ name: "📌 Additional Notes", value: loa.notes, inline: false }] : [])
    )
    .setFooter({ text: "東京ドリフトカスタム  ·  Leave of Absence" })
    .setTimestamp();
}
