import type { Client, Guild } from "discord.js";
import { db, getGuildConfig, getSetting, setSetting } from "../db.js";
import { refreshPayLogPanel } from "../commands/payall.js";
import { retryRecentOrderDeliveries } from "./orderDelivery.js";
import { logError } from "./eventLog.js";

const PAY_AND_ORDER_CHECK_MS = 10 * 60 * 1000;
const CREW_CHECK_MS = 60 * 60 * 1000;
const CREW_ALERT_PREFIX = "scheduled_crew_health:";

function crewIssues(result: {
  error?: string;
  missingDiscordMembers: string[];
  missingProfiles: string[];
  missingMechanicRoles: string[];
  missingSalesChannels: string[];
  staleSalesLinks: string[];
  failures: string[];
}) {
  return {
    error: result.error ?? "",
    missingDiscordMembers: result.missingDiscordMembers,
    missingProfiles: result.missingProfiles,
    missingMechanicRoles: result.missingMechanicRoles,
    missingSalesChannels: result.missingSalesChannels,
    staleSalesLinks: result.staleSalesLinks,
    failures: result.failures,
  };
}

async function postCrewHealthAlert(guild: Guild, message: string) {
  const config = await getGuildConfig(guild.id);
  const channelId = config?.log_channel_id ?? config?.payday_channel_id;
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  await (channel as any).send(message);
  return true;
}

async function runCrewHealthCheck(guild: Guild) {
  const { runCrewHealthCheck: scanCrew, buildCrewHealthEmbed } = await import("../commands/crew.js");
  const result = await scanCrew(guild, false);
  const issues = crewIssues(result);
  const hasIssues = Object.values(issues).some(value =>
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  );
  const key = `${CREW_ALERT_PREFIX}${guild.id}`;
  const prior = await getSetting(key);

  if (!hasIssues) {
    if (prior) {
      const sent = await postCrewHealthAlert(guild, "Crew health check is clear again. No crew or sales-channel mismatches were found.");
      if (sent) await db.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: [key] });
    }
    return;
  }

  const signature = JSON.stringify(issues);
  if (signature === prior) return;
  const config = await getGuildConfig(guild.id);
  const channelId = config?.log_channel_id ?? config?.payday_channel_id;
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await (channel as any).send({
      content: "Scheduled crew check found a mismatch. This scan is read-only; use `/crew sync` after reviewing the report.",
      embeds: [buildCrewHealthEmbed(result)],
    });
    await setSetting(key, signature);
  } else {
    console.warn(`[TDC] Crew health check found issues in guild ${guild.id}, but no log/payday channel is configured.`);
  }
}

export function startShopIntegrityChecks(client: Client) {
  let payAndOrdersRunning = false;
  let crewCheckRunning = false;

  const checkPayAndOrders = async () => {
    if (payAndOrdersRunning) return;
    payAndOrdersRunning = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        if (!(await getGuildConfig(guild.id))) continue;
        await refreshPayLogPanel(guild);
        const recovered = await retryRecentOrderDeliveries(client, guild);
        if (recovered > 0) {
          console.log(`[TDC] Reconciled ${recovered} pending order sales post(s) in guild ${guild.id}.`);
        }
      }
    } catch (error) {
      logError("scheduled-pay-order-check", error);
    } finally {
      payAndOrdersRunning = false;
    }
  };

  const checkCrew = async () => {
    if (crewCheckRunning) return;
    crewCheckRunning = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        if (!(await getGuildConfig(guild.id))) continue;
        try {
          await runCrewHealthCheck(guild);
        } catch (error) {
          logError("scheduled-crew-health-check", error, { guildId: guild.id });
        }
      }
    } finally {
      crewCheckRunning = false;
    }
  };

  const initialTimer = setTimeout(() => {
    void checkPayAndOrders();
    void checkCrew();
  }, 90_000);
  initialTimer.unref();
  setInterval(() => void checkPayAndOrders(), PAY_AND_ORDER_CHECK_MS);
  setInterval(() => void checkCrew(), CREW_CHECK_MS);
  console.log("[TDC] Scheduled pay-log/order delivery checks started (10m); read-only crew health checks started (60m).");
}
