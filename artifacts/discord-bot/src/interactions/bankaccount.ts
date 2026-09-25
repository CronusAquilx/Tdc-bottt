import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db, getGuildConfig, setSetting, checkpointDatabase, splitRoleIds } from "../db.js";
import { requireRole } from "../lib/roles.js";
import { COLORS, money } from "../lib/embeds.js";
import { randomUUID } from "../lib/utils.js";

const FOOTER = "東京ドリフトカスタム  ·  Built Different.";
const BANK_PANEL_TITLE = "🏦  DAILY BANK ACCOUNT";
const BANK_TIME_ZONE = process.env.TDC_TIMEZONE?.trim() || "America/Chicago";

function localDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BANK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return parsed.toLocaleDateString("en-US", {
    timeZone: BANK_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function bankButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("bank:log")
      .setLabel("🏦 Log Bank Balance")
      .setStyle(ButtonStyle.Primary)
  );
}

type BankComparison = {
  logDate: string;
  balance: number;
  previousBalance: number | null;
  orderRevenue: number;
  orderCount: number;
  payoutTotal: number;
  payoutCount: number;
  expectedBalance: number;
  actualChange: number;
  variance: number;
  shortfall: number;
  surplus: number;
  loggedBy: string;
  loggedAt: string;
  isUpdate: boolean;
};

async function getPreviousLog(guildId: string, logDate: string) {
  const result = await db.execute({
    sql: `SELECT id, balance, logged_at
          FROM bank_account_logs
          WHERE guild_id = ? AND log_date <> ?
          ORDER BY datetime(logged_at) DESC
          LIMIT 1`,
    args: [guildId, logDate],
  });
  return result.rows[0] ?? null;
}

async function getOrdersSince(guildId: string, loggedAt: string | null, through: string) {
  const result = await db.execute({
    sql: `SELECT COALESCE(SUM(total), 0), COUNT(*)
          FROM orders
          WHERE guild_id = ?
            AND status IN ('complete', 'approved', 'paid')
            AND datetime(COALESCE(completed_at, created_at)) > datetime(?)
            AND datetime(COALESCE(completed_at, created_at)) <= datetime(?)`,
    args: [guildId, loggedAt ?? "2000-01-01 00:00:00", through],
  });
  return {
    revenue: Number(result.rows[0]?.[0] ?? 0),
    count: Number(result.rows[0]?.[1] ?? 0),
  };
}

async function getPayoutsSince(loggedAt: string | null, through: string) {
  const result = await db.execute({
    sql: `SELECT
            COALESCE(SUM(amount + COALESCE(manager_cut, 0)), 0),
            COUNT(CASE WHEN amount + COALESCE(manager_cut, 0) > 0 THEN 1 END)
          FROM payouts
          WHERE paid_at IS NOT NULL
            AND datetime(paid_at) > datetime(?)
            AND datetime(paid_at) <= datetime(?)`,
    args: [loggedAt ?? "2000-01-01 00:00:00", through],
  });
  return {
    amount: Number(result.rows[0]?.[0] ?? 0),
    count: Number(result.rows[0]?.[1] ?? 0),
  };
}

export async function recordBankBalance(
  guildId: string,
  balance: number,
  loggedBy: string,
  date = localDate(),
): Promise<BankComparison> {
  const previous = await getPreviousLog(guildId, date);
  const loggedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const orderTotals = previous
    ? await getOrdersSince(guildId, String(previous[2]), loggedAt)
    : { revenue: 0, count: 0 };
  const payoutTotals = previous
    ? await getPayoutsSince(String(previous[2]), loggedAt)
    : { amount: 0, count: 0 };
  const previousBalance = previous ? Number(previous[1] ?? 0) : null;
  const actualChange = previousBalance === null ? 0 : balance - previousBalance;
  const expectedChange = orderTotals.revenue - payoutTotals.amount;
  const expectedBalance = previousBalance === null ? balance : previousBalance + expectedChange;
  const variance = previousBalance === null ? 0 : actualChange - expectedChange;

  const existing = await db.execute({
    sql: "SELECT id FROM bank_account_logs WHERE guild_id = ? AND log_date = ?",
    args: [guildId, date],
  });
  const id = existing.rows[0]?.[0] ? String(existing.rows[0][0]) : randomUUID();
  await db.execute({
    sql: `INSERT INTO bank_account_logs
            (id, guild_id, log_date, balance, expected_change, payout_total,
             expected_balance, actual_change, variance, order_count, logged_by, logged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(guild_id, log_date) DO UPDATE SET
            balance = excluded.balance,
            expected_change = excluded.expected_change,
            payout_total = excluded.payout_total,
            expected_balance = excluded.expected_balance,
            actual_change = excluded.actual_change,
            variance = excluded.variance,
            order_count = excluded.order_count,
            logged_by = excluded.logged_by,
            logged_at = excluded.logged_at`,
    args: [
      id,
      guildId,
      date,
      balance,
      expectedChange,
      payoutTotals.amount,
      expectedBalance,
      actualChange,
      variance,
      orderTotals.count,
      loggedBy,
      loggedAt,
    ],
  });
  await setSetting(`bank_daily_prompt:${guildId}`, date);
  await checkpointDatabase();

  return {
    logDate: date,
    balance,
    previousBalance,
    orderRevenue: orderTotals.revenue,
    orderCount: orderTotals.count,
    payoutTotal: payoutTotals.amount,
    payoutCount: payoutTotals.count,
    expectedBalance,
    actualChange,
    variance,
    shortfall: Math.max(0, -variance),
    surplus: Math.max(0, variance),
    loggedBy,
    loggedAt,
    isUpdate: Boolean(existing.rows[0]),
  };
}

async function getLatestLog(guildId: string) {
  const result = await db.execute({
    sql: `SELECT log_date, balance, expected_balance, variance, logged_by
          FROM bank_account_logs
          WHERE guild_id = ?
          ORDER BY datetime(logged_at) DESC
          LIMIT 1`,
    args: [guildId],
  });
  return result.rows[0] ?? null;
}

function varianceText(comparison: BankComparison): string {
  if (comparison.previousBalance === null) return "Baseline entry — future logs will compare against this balance.";
  if (comparison.shortfall > 0) {
    return `⚠️ **${money(comparison.shortfall)} short** of the expected bank balance.`;
  }
  if (comparison.surplus > 0) {
    return `✅ **${money(comparison.surplus)} over** the expected bank balance.`;
  }
  return "✅ The bank matches the expected balance.";
}

export function buildBankLogEmbed(comparison: BankComparison): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🏦  BANK BALANCE LOG — ${formatDate(comparison.logDate)}`)
    .setColor(comparison.shortfall > 0 ? COLORS.rejected : comparison.surplus > 0 ? COLORS.warning : COLORS.approved)
    .setDescription(
      `${comparison.isUpdate ? "Updated" : "Logged"} by <@${comparison.loggedBy}>.\n\n` +
      `${varianceText(comparison)}`
    )
    .addFields(
      { name: "Actual bank balance", value: `**${money(comparison.balance)}**`, inline: true },
      { name: "Bank should be at", value: `**${money(comparison.expectedBalance)}**`, inline: true },
      {
        name: "Change since last log",
        value: comparison.previousBalance === null ? "First entry" : `**${comparison.actualChange >= 0 ? "+" : ""}${money(comparison.actualChange)}**`,
        inline: true,
      },
      {
        name: "💸 Paid out since last log",
        value: `**${money(comparison.payoutTotal)}** across ${comparison.payoutCount} payout${comparison.payoutCount === 1 ? "" : "s"}`,
        inline: false,
      },
      {
        name: "Car-order revenue expected",
        value: `**${money(comparison.orderRevenue)}** from ${comparison.orderCount} completed order${comparison.orderCount === 1 ? "" : "s"}`,
        inline: false,
      },
    )
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date(`${comparison.loggedAt.replace(" ", "T")}Z`));
  return embed;
}

export async function buildBankPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const latest = await getLatestLog(guildId);
  const latestText = latest
    ? `Last logged balance: **${money(Number(latest[1] ?? 0))}** on **${formatDate(String(latest[0]))}**.`
    : "No bank balance has been logged yet.";
  return new EmbedBuilder()
    .setTitle(BANK_PANEL_TITLE)
    .setColor(COLORS.primary)
    .setDescription(
      "**Managers and owners:** use the button below to log the current daily bank balance.\n\n" +
      "The bot compares the change since the last log with completed car-order revenue minus recorded payouts and reports:\n" +
      "• the actual change in the bank\n" +
      "• the expected balance after order revenue and recorded payouts\n" +
      "• any shortfall or surplus\n\n" +
      latestText
    )
    .setFooter({ text: `${FOOTER}  ·  Daily reminders at 12:00 AM ${BANK_TIME_ZONE}` });
}

export async function postBankAccountPanel(channel: TextChannel, guildId?: string): Promise<void> {
  const resolvedGuildId = guildId ?? channel.guild?.id;
  if (!resolvedGuildId) return;
  const embed = await buildBankPanelEmbed(resolvedGuildId);
  try {
    const pins = await channel.messages.fetchPinned();
    const existing = pins.find(message =>
      message.author.id === channel.client.user?.id &&
      message.embeds[0]?.title?.includes("DAILY BANK ACCOUNT")
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components: [bankButtonRow()] });
      return;
    }
  } catch { /* post a fresh panel */ }
  const message = await channel.send({ embeds: [embed], components: [bankButtonRow()] });
  try { await message.pin(); } catch { /* pinning is optional */ }
}

export async function handleBankButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== "bank:log") return false;
  if (!(await requireRole(interaction, "manager"))) return true;
  const modal = new ModalBuilder()
    .setCustomId("bank:log")
    .setTitle("🏦 Log Daily Bank Balance")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("balance")
          .setLabel("Current bank balance")
          .setPlaceholder("Example: 125000 or $125,000")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
      )
    );
  await interaction.showModal(modal);
  return true;
}

export async function handleBankModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== "bank:log") return false;
  if (!(await requireRole(interaction, "manager"))) return true;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.fields.getTextInputValue("balance").replace(/[$,\\s]/g, "");
  const balance = Number(raw);
  if (!Number.isFinite(balance) || balance < 0) {
    await interaction.editReply({ content: "❌ Enter a valid bank balance of 0 or more." });
    return true;
  }

  const comparison = await recordBankBalance(interaction.guild!.id, balance, interaction.user.id);
  const config = await getGuildConfig(interaction.guild!.id);
  const channel = config?.bank_account_channel_id
    ? await interaction.guild!.channels.fetch(config.bank_account_channel_id).catch(() => null)
    : null;
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: "✅ Balance saved, but the bank-account channel is no longer available." });
    return true;
  }

  await (channel as TextChannel).send({ embeds: [buildBankLogEmbed(comparison)] });
  await interaction.editReply({
    content: `✅ Bank balance saved for **${formatDate(comparison.logDate)}**.\n${varianceText(comparison)}`,
  });
  return true;
}

async function managementMentions(guildId: string, config: any): Promise<{ content: string; roles: string[] }> {
  const roleIds = [
    ...splitRoleIds(config?.owner_role_id),
    ...splitRoleIds(config?.manager_role_id),
  ];
  if (roleIds.length) {
    return { content: roleIds.map(id => `<@&${id}>`).join(" "), roles: roleIds };
  }
  const result = await db.execute(
    "SELECT DISTINCT discord_id FROM user_roles WHERE role IN ('owner', 'manager')"
  );
  const userIds = result.rows.map(row => String(row[0] ?? "")).filter(Boolean);
  return { content: userIds.map(id => `<@${id}>`).join(" "), roles: [] };
}

export async function sendBankReminder(guild: import("discord.js").Guild): Promise<boolean> {
  const config = await getGuildConfig(guild.id);
  const channelId = config?.bank_account_channel_id;
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const mentions = await managementMentions(guild.id, config);
  const message = await (channel as TextChannel).send({
    content: `${mentions.content}\n🌙 Daily bank-account check — please log the current balance.`,
    embeds: [await buildBankPanelEmbed(guild.id)],
    components: [bankButtonRow()],
    allowedMentions: { roles: mentions.roles, users: mentions.roles.length ? [] : undefined },
  });
  return Boolean(message);
}

export async function scheduleNextBankReminder(guild: import("discord.js").Guild): Promise<boolean> {
  const config = await getGuildConfig(guild.id);
  const channelId = config?.bank_account_channel_id;
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  await setSetting(`bank_daily_prompt:${guild.id}`, localDate());
  return true;
}

export function scheduleDailyBankPrompts(client: Client): void {
  const tick = async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BANK_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find(part => part.type === "hour")?.value ?? -1);
    const minute = Number(parts.find(part => part.type === "minute")?.value ?? -1);
    if (hour !== 0 || minute >= 5) return;

    const date = localDate(now);
    const rows = await db.execute(
      "SELECT guild_id FROM guild_config WHERE bank_account_channel_id IS NOT NULL"
    );
    for (const row of rows.rows) {
      const guildId = String(row[0] ?? "");
      if (!guildId) continue;
      const settingKey = `bank_daily_prompt:${guildId}`;
      const sentFor = await db.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [settingKey] });
      if (String(sentFor.rows[0]?.[0] ?? "") === date) continue;
      try {
        const guild = await client.guilds.fetch(guildId);
        if (await sendBankReminder(guild)) await setSetting(settingKey, date);
      } catch (error) {
        console.error(`[TDC] Bank-account daily reminder failed for guild ${guildId}:`, error);
      }
    }
  };
  setInterval(() => tick().catch(error => console.error("[TDC] Bank scheduler error:", error)), 60 * 1000);
  console.log(`[TDC] 🏦 Daily bank-account reminders started (${BANK_TIME_ZONE})`);
}