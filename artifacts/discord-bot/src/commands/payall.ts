import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Guild, TextChannel
, MessageFlags} from "discord.js";
import { db, getProfile, getGuildConfig, splitRoleIds, saveDatabaseSnapshot } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { weekStart } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different. Driven Hard.";

export const data = new SlashCommandBuilder()
  .setName("payall")
  .setDescription("Process weekly payout for ALL crew and notify mechanics (manager+)");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await requireRole(interaction, "manager"))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = await buildPayallSummaryEmbed(weekStart(), interaction.guild ?? undefined);
  if (!embed) {
    await interaction.editReply({ content: "❌ No unpaid completed orders this week." });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("payall:confirm").setLabel("💸  Pay All + Notify Crew").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("payall:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function buildPayallSummaryEmbed(ws: string, guild?: Guild): Promise<EmbedBuilder | null> {
  // Always use order_number_reset_ts as the pay-period boundary so it stays in sync
  // with the snapshot formula used everywhere else (getCommissionData, mysales, etc.)
  const SINCE_RESET = `datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND ${SINCE_RESET}`,
    args: []
  });

  const mechanicMap = new Map<string, { name: string; rate: number; labour: number; orders: number; revenue: number; hours: number }>();
  for (const row of ordersR.rows) {
    const mid    = String(row[0]);
    const labour = Number(row[1] ?? 0);
    const total  = Number(row[2] ?? 0);
    const name   = String(row[3] ?? "");
    const rate   = Number(row[4] ?? 0.3);
    const hours  = Number(row[5] ?? 0);
    if (!mechanicMap.has(mid)) mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
    const e = mechanicMap.get(mid)!;
    e.labour += labour; e.orders += 1; e.revenue += total;
  }

  // Also include anyone with mechanic/trainer guild roles (even if no orders this week)
  if (guild) {
    try {
      const config = await getGuildConfig(guild.id);
      const roleIds = [
        ...splitRoleIds(config?.mechanic_role_id),
        ...splitRoleIds(config?.trainer_role_id)
      ];
      for (const roleId of roleIds) {
        try {
          const role = await guild.roles.fetch(roleId).catch(() => null);
          if (!role) continue;
          for (const [memberId] of role.members) {
            if (mechanicMap.has(memberId)) continue;
            const profile = await getProfile(memberId);
            const name = profile?.display_name ?? "Unknown";
            const rate = profile?.commission_rate ?? 0.3;
            const hours = profile?.hours_worked_this_week ?? 0;
            mechanicMap.set(memberId, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
          }
        } catch { /* role not found */ }
      }
    } catch { /* ignore */ }
  }

  if (!mechanicMap.size) return null;

  // Pull commission adjustments + snapshots for the snapshot formula
  const adjustSummaryR = await db.execute(
    "SELECT discord_id, commission_adjustment, commission_labour_snapshot FROM profiles"
  );
  const adjustSummaryMap = new Map<string, { adj: number; snapshot: number }>();
  for (const row of adjustSummaryR.rows) {
    adjustSummaryMap.set(String(row[0] ?? ""), {
      adj:      Number(row[1] ?? 0),
      snapshot: Number(row[2] ?? 0)
    });
  }

  let grandCommission = 0;
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const commissionMap = new Map<string, number>();

  for (const [mid, m] of mechanicMap) {
    const { adj = 0, snapshot = 0 } = adjustSummaryMap.get(mid) ?? {};
    const labourAfterSetpay = Math.max(0, m.labour - snapshot);
    const commission = adj > 0
      ? adj + labourAfterSetpay * m.rate
      : m.labour * m.rate;
    grandCommission += commission;
    totalLabour     += m.labour;
    totalRevenue    += m.revenue;
    commissionMap.set(mid, commission);
  }

  // Manager cuts — snapshot-based formula (same as getCommissionData). Folded into
  // each manager's own commission line below so the panel shows ONE total, not two.
  const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const managersR = await db.execute(
    "SELECT p.discord_id, p.display_name, p.manager_override_rate, p.manager_cut_adjustment, p.manager_labour_snapshot FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
  );
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const managerId    = String(row[0] ?? "");
    const managerName  = String(row[1] ?? "Unknown");
    const manualBonus  = Number(row[3] ?? 0);
    const managerSnap  = Number(row[4] ?? 0);
    const overrideRate = Number(row[2] ?? 0.20);
    // Fetch crew labour (mechanic/trainer role_level orders, excluding the manager's own)
    const crewLabourR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
      args: [managerId]
    });
    const crewLabour = Number(crewLabourR.rows[0]?.[0] ?? 0);
    const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
    const cut = manualBonus > 0
      ? manualBonus + crewAfterSnap * overrideRate
      : crewLabour * overrideRate;
    if (cut > 0) {
      totalManagerCuts += cut;
      if (!mechanicMap.has(managerId)) {
        mechanicMap.set(managerId, { name: managerName, rate: overrideRate, labour: 0, orders: 0, revenue: 0, hours: 0 });
      }
      commissionMap.set(managerId, (commissionMap.get(managerId) ?? 0) + cut);
    }
  }

  const payLines: string[] = [];
  for (const [mid, m] of mechanicMap) {
    const total = commissionMap.get(mid) ?? 0;
    const hrsNote = m.hours > 0 ? ` · ${m.hours.toFixed(1)}h` : "";
    payLines.push(`**${m.name}** · ${m.orders} orders${hrsNote} → Total: **${money(total)}**`);
  }

  if (!payLines.length) return null;

  const totalToBill = grandCommission + totalManagerCuts;

  const embed = new EmbedBuilder()
    .setTitle("💸  WEEKLY PAYROLL SUMMARY")
    .setColor(0xffd700)
    .setDescription(
      `**Pay period:** Week of \`${ws}\`\n` +
      `**Total revenue:** ${money(totalRevenue)}\n\n` +
      "Review all payouts below. Click **Pay All + Notify Crew** to process payroll,\n" +
      "send pay messages to every sales channel, and start the new week.\n\n" +
      "⚠️ This will **mark all orders as paid** and **reset weekly stats**."
    );

  // Discord limits each embed field value to 1,024 characters. A real crew
  // can exceed that when every mechanic is listed, which previously caused
  // the Pay All button to fall into the generic "Something went wrong" error.
  const payoutFields: { name: string; value: string; inline: boolean }[] = [];
  let payoutChunk = "";
  let payoutChunkIndex = 0;
  for (const line of payLines) {
    const addition = payoutChunk ? `\n${line}` : line;
    if (payoutChunk && payoutChunk.length + addition.length > 1000) {
      payoutFields.push({
        name: payoutChunkIndex === 0 ? `🔩 Crew Payouts (${mechanicMap.size} people)` : "\u200b",
        value: payoutChunk,
        inline: false
      });
      payoutChunk = line;
      payoutChunkIndex++;
    } else {
      payoutChunk += addition;
    }
  }
  if (payoutChunk || !payoutFields.length) {
    payoutFields.push({
      name: payoutChunkIndex === 0 ? `🔩 Crew Payouts (${mechanicMap.size} people)` : "\u200b",
      value: payoutChunk || "None",
      inline: false
    });
  }
  embed.addFields(...payoutFields);

  embed.addFields(
    { name: "💰 Total to Bill Company", value: `**${money(totalToBill)}**`, inline: true },
    { name: "📋 Total Orders",          value: String(ordersR.rows.length),  inline: true }
  );

  embed.setFooter({ text: FOOTER }).setTimestamp();
  return embed;
}

const PAY_LOG_PANEL_TITLE = "💸  WEEKLY PAY LOG  ·  TOKYO DRIFT CUSTOMS";
/** Guild-scoped settings key so multiple guilds don't stomp each other's panel msg ID */
const payLogMsgKey = (guildId: string) => `paylogs_panel_msg_id:${guildId}`;

/**
 * Builds the live per-mechanic pay log embed shown in the pay-logs channel.
 * Shows every crew member's weekly commission, order count, hours, and paid/pending status.
 */
export async function buildPayLogPanelEmbed(guild?: Guild): Promise<EmbedBuilder> {
  const SINCE_RESET = `datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  // Single query: all profiles with their week labour + order counts
  const r = await db.execute({
    sql: `SELECT
            p.discord_id,
            p.display_name,
            p.commission_rate,
            p.hours_worked_this_week,
            p.commission_adjustment,
            p.commission_labour_snapshot,
            p.current_pay_status,
            COALESCE(SUM(CASE WHEN o.status IN ('complete','approved','paid') AND ${SINCE_RESET} THEN o.labour ELSE 0 END), 0) AS week_labour,
            COUNT(CASE WHEN o.status IN ('complete','approved','paid') AND ${SINCE_RESET} THEN 1 ELSE NULL END) AS week_orders
          FROM profiles p
          LEFT JOIN orders o ON o.mechanic_id = p.discord_id
          GROUP BY p.discord_id
          ORDER BY week_labour DESC`,
    args: []
  });

  const ws = weekStart();
  const nowTs = Math.floor(Date.now() / 1000);

  if (!r.rows.length) {
    return new EmbedBuilder()
      .setTitle(PAY_LOG_PANEL_TITLE)
      .setColor(0xffd700)
      .setDescription(
        `**Pay period:** Week of \`${ws}\`\n\n` +
        "*No crew profiles found yet.*\n\n" +
        `🔄 Last updated: <t:${nowTs}:R>`
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();
  }

  // Manager cuts — same snapshot-based formula used in /payall, keyed by discord_id
  // so we can fold each manager's crew cut into their pay log line + the grand total.
  const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const managersR = await db.execute(
    "SELECT p.discord_id, p.manager_override_rate, p.manager_cut_adjustment, p.manager_labour_snapshot FROM profiles p INNER JOIN user_roles ur ON p.discord_id = ur.discord_id WHERE ur.role IN ('manager','owner')"
  );
  const managerCutMap = new Map<string, number>();
  for (const row of managersR.rows) {
    const managerId    = String(row[0] ?? "");
    const overrideRate = Number(row[1] ?? 0.20);
    const manualBonus  = Number(row[2] ?? 0);
    const managerSnap  = Number(row[3] ?? 0);
    const crewLabourR = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved','paid') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
      args: [managerId]
    });
    const crewLabour = Number(crewLabourR.rows[0]?.[0] ?? 0);
    const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
    const cut = manualBonus > 0
      ? manualBonus + crewAfterSnap * overrideRate
      : crewLabour * overrideRate;
    if (cut > 0) managerCutMap.set(managerId, cut);
  }

  const lines: string[] = [];
  let grandTotal = 0;

  for (const row of r.rows) {
    const discordId  = String(row[0] ?? "");
    const name       = String(row[1] ?? "Unknown");
    const rate       = Number(row[2] ?? 0.3);
    const adj        = Number(row[4] ?? 0);
    const snapshot   = Number(row[5] ?? 0);
    const payStatus  = String(row[6] ?? "pending");
    const weekLabour = Number(row[7] ?? 0);
    const weekOrders = Number(row[8] ?? 0);

    const labourAfter  = Math.max(0, weekLabour - snapshot);
    let commission      = adj > 0 ? adj + labourAfter * rate : weekLabour * rate;

    const managerCut = managerCutMap.get(discordId) ?? 0;
    commission += managerCut;
    grandTotal += commission;

    const statusIcon  = payStatus === "paid" ? "💚" : "🔴";
    lines.push(`${statusIcon} **${name}** — ${weekOrders} orders — Total: **${money(Math.round(commission))}**`);
  }

  // Chunk into fields to stay under Discord's 1024-char limit
  const fields: { name: string; value: string; inline: boolean }[] = [];
  let chunk = "";
  let chunkIdx = 0;
  for (const line of lines) {
    const addition = (chunk ? "\n" : "") + line;
    if (chunk.length + addition.length > 1020) {
      fields.push({ name: chunkIdx === 0 ? "🔩 Crew — Weekly Commission" : "\u200b", value: chunk, inline: false });
      chunk = line; chunkIdx++;
    } else {
      chunk += addition;
    }
  }
  if (chunk) fields.push({ name: chunkIdx === 0 ? "🔩 Crew — Weekly Commission" : "\u200b", value: chunk, inline: false });
  fields.push({ name: "💰 Total to Bill Company", value: `**${money(Math.round(grandTotal))}**`, inline: true });

  return new EmbedBuilder()
    .setTitle(PAY_LOG_PANEL_TITLE)
    .setColor(0xffd700)
    .setDescription(
      `**Pay period:** Week of \`${ws}\`\n` +
      `💚 = paid  🔴 = pending\n\n` +
      `🔄 Last updated: <t:${nowTs}:R>`
    )
    .addFields(...fields)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function buildPayLogButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:payroll:setpay").setLabel("💰 Set Individual Pay").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("payall:schedulenow").setLabel("📅 Pay All").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:payroll:lifetimeearnings").setLabel("🏆 Lifetime Earnings").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("admin:payroll:markpaid").setLabel("💚 Mark Paid").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin:payroll:markunpaid").setLabel("🔴 Mark Pending").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("admin:payroll:newweek").setLabel("🔄 Start New Week").setStyle(ButtonStyle.Primary),
    )
  ];
}

/**
 * Posts (or edits the existing pinned) pay log panel in the channel.
 * Always pins the panel and stores its message ID so refreshPayLogPanel can edit it.
 */
export async function postPayLogPanel(channel: TextChannel, guild?: Guild): Promise<void> {
  const { getSetting, setSetting } = await import("../db.js");
  const embed      = await buildPayLogPanelEmbed(guild);
  const components = buildPayLogButtons();

  const guildId = guild?.id ?? (channel as any).guild?.id ?? "default";

  // Try to find and edit an existing pinned panel from the bot
  try {
    const pins = await channel.messages.fetchPinned();
    const existing = pins.find(m =>
      m.author.id === channel.client.user?.id &&
      (m.embeds[0]?.title?.includes("PAY LOG") || m.embeds[0]?.title?.includes("PAYROLL"))
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      await setSetting(payLogMsgKey(guildId), existing.id);
      return;
    }
  } catch { /* ignore */ }

  // No existing panel — post new and pin it
  const msg = await channel.send({ embeds: [embed], components });
  try { await msg.pin(); } catch { /* ignore */ }
  await setSetting(payLogMsgKey(guildId), msg.id);
}

/**
 * Silently refreshes the pinned pay log panel in place.
 * Call this after every order completion and after every week reset.
 */
export async function refreshPayLogPanel(guild: Guild | null): Promise<void> {
  if (!guild) return;
  try {
    const { getGuildConfig, getSetting, setSetting } = await import("../db.js");
    const config  = await getGuildConfig(guild.id);
    const chanId  = config?.payday_channel_id;
    if (!chanId) return;

    const ch = await guild.channels.fetch(chanId).catch(() => null);
    if (!ch?.isTextBased()) return;

    const embed      = await buildPayLogPanelEmbed(guild);
    const components = buildPayLogButtons();

    // 1) Try by stored message ID
    const msgId = await getSetting(payLogMsgKey(guild.id));
    if (msgId) {
      const msg = await (ch as any).messages.fetch(msgId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components });
        return;
      }
    }

    // 2) Stored ID is stale — scan the channel for an existing panel (survives DB wipes / redeploys)
    try {
      const recent = await (ch as any).messages.fetch({ limit: 30 });
      const existing = [...recent.values()].find((m: any) =>
        m.author?.bot && m.embeds?.[0]?.title?.includes("PAY LOG")
      );
      if (existing) {
        await (existing as any).edit({ embeds: [embed], components });
        await setSetting(payLogMsgKey(guild.id), (existing as any).id);
        return;
      }
    } catch { /* fallthrough to post new */ }

    // 3) Nothing found — post a fresh panel and pin it
    const newMsg = await (ch as any).send({ embeds: [embed], components });
    try { await (newMsg as any).pin(); } catch { /* ignore */ }
    await setSetting(payLogMsgKey(guild.id), (newMsg as any).id);
  } catch { /* never let panel refresh crash the caller */ }
}

export async function processPayall(
  guild: Guild | null,
  ws: string,
  paidById: string
): Promise<{ grandCommission: number; totalRevenue: number; mechanicCount: number; totalToBill: number; payouts: Array<{ payoutId: string | null; mechanicId: string; amount: number; managerCut: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }> } | null> {
  // Use order_number_reset_ts as the pay-period boundary — same as all other commission calculations
  const SINCE_RESET = `datetime(COALESCE(o.completed_at, o.created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;

  const ordersR = await db.execute({
    sql: `SELECT o.mechanic_id, o.labour, o.total, p.display_name, p.commission_rate, p.hours_worked_this_week
          FROM orders o JOIN profiles p ON o.mechanic_id = p.discord_id
          WHERE o.status IN ('complete','approved') AND ${SINCE_RESET}`,
    args: []
  });

  const mechanicMap = new Map<string, { name: string; rate: number; labour: number; orders: number; revenue: number; hours: number }>();
  for (const row of ordersR.rows) {
    const mid    = String(row[0]);
    const labour = Number(row[1] ?? 0);
    const total  = Number(row[2] ?? 0);
    const name   = String(row[3] ?? "");
    const rate   = Number(row[4] ?? 0.3);
    const hours  = Number(row[5] ?? 0);
    if (!mechanicMap.has(mid)) mechanicMap.set(mid, { name, rate, labour: 0, orders: 0, revenue: 0, hours });
    const e = mechanicMap.get(mid)!;
    e.labour += labour; e.orders += 1; e.revenue += total;
  }

  let grandCommission = 0;
  let totalLabour     = 0;
  let totalRevenue    = 0;
  const { randomUUID } = await import("../lib/utils.js");

  // Pull ALL profile info in one shot — we need this to include crew who have
  // manually-set pay (/setpay) or manager cuts but zero orders this period,
  // as well as everyone else so they still get a "new week" message.
  const allProfilesR = await db.execute(
    "SELECT discord_id, display_name, commission_rate, hours_worked_this_week, commission_adjustment, commission_labour_snapshot, sales_channel_id FROM profiles"
  );
  const adjustMap = new Map<string, { adj: number; snapshot: number }>();
  const salesChanMap = new Map<string, string | null>();
  const profileMetaMap = new Map<string, { name: string; rate: number; hours: number }>();
  for (const row of allProfilesR.rows) {
    const id       = String(row[0] ?? "");
    const name     = String(row[1] ?? "Unknown");
    const rate     = Number(row[2] ?? 0.3);
    const hours    = Number(row[3] ?? 0);
    const adj      = Number(row[4] ?? 0);
    const snapshot = Number(row[5] ?? 0);
    const salesChan = row[6] ? String(row[6]) : null;
    adjustMap.set(id, { adj, snapshot });
    salesChanMap.set(id, salesChan);
    profileMetaMap.set(id, { name, rate, hours });
  }

  const payoutResults: Array<{ payoutId: string | null; mechanicId: string; amount: number; managerCut: number; orders: number; hours: number; name: string; salesChanId: string | null; rate: number }> = [];
  const processedIds = new Set<string>();

  for (const [mid, m] of mechanicMap) {
    const { adj = 0, snapshot = 0 } = adjustMap.get(mid) ?? {};
    const labourAfterSetpay = Math.max(0, m.labour - snapshot);
    const commission  = adj > 0
      ? adj + labourAfterSetpay * m.rate
      : m.labour * m.rate;
    grandCommission  += commission;
    totalLabour      += m.labour;
    totalRevenue     += m.revenue;
    const payoutId = randomUUID();
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, mid, ws, commission, m.orders, m.hours, m.orders, paidById]
    });
    payoutResults.push({
      payoutId,
      mechanicId: mid,
      amount: commission,
      managerCut: 0,
      orders: m.orders,
      hours: m.hours,
      name: m.name,
      salesChanId: salesChanMap.get(mid) ?? null,
      rate: m.rate
    });
    processedIds.add(mid);
  }

  // Crew with manually-set pay (/setpay) but zero orders this period still get paid.
  for (const [id, { adj, snapshot }] of adjustMap) {
    if (processedIds.has(id) || adj <= 0) continue;
    const commission = adj; // no orders this period => labourAfterSetpay is 0
    grandCommission += commission;
    const meta = profileMetaMap.get(id) ?? { name: "Unknown", rate: 0.3, hours: 0 };
    const payoutId = randomUUID();
    await db.execute({
      sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)",
      args: [payoutId, id, ws, commission, 0, meta.hours, 0, paidById]
    });
    payoutResults.push({
      payoutId,
      mechanicId: id,
      amount: commission,
      managerCut: 0,
      orders: 0,
      hours: meta.hours,
      name: meta.name,
      salesChanId: salesChanMap.get(id) ?? null,
      rate: meta.rate
    });
    processedIds.add(id);
  }

  // Compute manager cuts BEFORE marking orders paid and BEFORE resetting snapshots
  const SINCE_RESET_BARE = `datetime(COALESCE(completed_at, created_at)) >= datetime(COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_reset_ts'), '2000-01-01'))`;
  const managersR = await db.execute(
    "SELECT discord_id, manager_override_rate, manager_cut_adjustment, manager_labour_snapshot FROM profiles INNER JOIN user_roles USING (discord_id) WHERE role IN ('manager','owner')"
  );
  let totalManagerCuts = 0;
  for (const row of managersR.rows) {
    const managerId    = String(row[0] ?? "");
    const overrideRate = Number(row[1] ?? 0.20);
    const manualBonus  = Number(row[2] ?? 0);
    const managerSnap  = Number(row[3] ?? 0);
    const crewLabourR  = await db.execute({
      sql: `SELECT COALESCE(SUM(labour), 0) FROM orders WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE} AND mechanic_id != ? AND role_level IN ('mechanic','trainer')`,
      args: [managerId]
    });
    const crewLabour   = Number(crewLabourR.rows[0]?.[0] ?? 0);
    const crewAfterSnap = Math.max(0, crewLabour - managerSnap);
    const cut = manualBonus > 0
      ? manualBonus + crewAfterSnap * overrideRate
      : crewLabour * overrideRate;
    totalManagerCuts += cut;
    // Attach manager cut to their payout record so the notification shows the full amount
    const pRecord = payoutResults.find(p => p.mechanicId === managerId);
    if (pRecord) {
      pRecord.managerCut = cut;
      if (pRecord.payoutId) {
        await db.execute({
          sql: "UPDATE payouts SET manager_cut = ? WHERE id = ?",
          args: [cut, pRecord.payoutId],
        });
      }
    } else if (cut > 0) {
      // Manager has no orders/manual pay of their own but still earned a crew cut
      const meta = profileMetaMap.get(managerId) ?? { name: "Unknown", rate: overrideRate, hours: 0 };
      const payoutId = randomUUID();
      await db.execute({
        sql: "INSERT INTO payouts (id, mechanic_id, week_start, amount, order_count, hours_worked, invoice_count, paid_at, paid_by, manager_cut) VALUES (?, ?, ?, 0, 0, ?, 0, datetime('now'), ?, ?)",
        args: [payoutId, managerId, ws, meta.hours, paidById, cut],
      });
      payoutResults.push({
        payoutId,
        mechanicId: managerId,
        amount: 0,
        managerCut: cut,
        orders: 0,
        hours: meta.hours,
        name: meta.name,
        salesChanId: salesChanMap.get(managerId) ?? null,
        rate: meta.rate
      });
      processedIds.add(managerId);
    }
  }

  // Everyone else with a sales channel gets included too (at $0) purely so they
  // still receive the "new week" announcement — just without a billing amount or ping.
  for (const [id, salesChan] of salesChanMap) {
    if (processedIds.has(id) || !salesChan) continue;
    const meta = profileMetaMap.get(id) ?? { name: "Unknown", rate: 0.3, hours: 0 };
    payoutResults.push({
      payoutId: null,
      mechanicId: id,
      amount: 0,
      managerCut: 0,
      orders: 0,
      hours: meta.hours,
      name: meta.name,
      salesChanId: salesChan,
      rate: meta.rate
    });
    processedIds.add(id);
  }

  if (!payoutResults.length) return null;

  // Mark all unpaid complete orders as paid
  await db.execute({
    sql: `UPDATE orders SET status = 'paid', completed_at = COALESCE(completed_at, datetime('now')) WHERE status IN ('complete','approved') AND ${SINCE_RESET_BARE.replace(/o\./g, "")}`,
    args: []
  });

  // Reset weekly stats + clear manual pay adjustments + snapshots for everyone
  await db.execute("UPDATE profiles SET hours_worked_this_week = 0, commission_adjustment = 0, manager_cut_adjustment = 0, commission_labour_snapshot = 0, manager_labour_snapshot = 0");

  // Record pay-period boundary — order_seq counter is NOT reset (globally monotonic).
  // The reset_ts is used only to scope which orders belong to the current pay period.
  // Use SQLite-compatible format (YYYY-MM-DD HH:MM:SS) so datetime() parses it correctly.
  const { setSetting } = await import("../db.js");
  await setSetting("order_number_reset_ts", new Date().toISOString().replace("T", " ").slice(0, 19));
  // Do not leave a completed Pay All only in the WAL. This makes the payout,
  // paid order statuses, and reset boundary survive an immediate restart.
  await saveDatabaseSnapshot();

  // Log the payout event
  const { logEvent } = await import("../lib/eventLog.js");
  const paidCount = payoutResults.filter(p => (p.amount + p.managerCut) > 0).length;

  logEvent({
    kind: "payout_processed",
    guildId: guild?.id,
    userId: paidById,
    amount: Math.round(grandCommission + totalManagerCuts),
    detail: `${paidCount} crew paid, ${ordersR.rows.length} orders, week ${ws}`
  });

  return {
    grandCommission,
    totalRevenue,
    mechanicCount: paidCount,
    totalToBill: grandCommission + totalManagerCuts,
    payouts: payoutResults
  };
}
