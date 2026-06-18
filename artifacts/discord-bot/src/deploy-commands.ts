import { REST, Routes } from "discord.js";
import { data as orderData } from "./commands/order.js";
import { data as crewData } from "./commands/crew.js";
import { data as timeclockData } from "./commands/timeclock.js";
import { data as timeclockManageData } from "./commands/timeclockmanage.js";
import { data as mysalesData } from "./commands/mysales.js";
import { data as breakdownData } from "./commands/breakdown.js";
import { data as analyticsData } from "./commands/analytics.js";
import { data as commissionData } from "./commands/commission.js";
import { data as payData } from "./commands/pay.js";
import { data as jobData } from "./commands/job.js";
import { data as setupData } from "./commands/setup.js";
import { data as settingsData } from "./commands/settings.js";

const token = process.env.DISCORD_TOKEN!;

// Extract application ID from token
const parts = token.split(".");
const clientId = Buffer.from(parts[0], "base64").toString("utf-8");

const commands = [
  orderData,
  crewData,
  timeclockData,
  timeclockManageData,
  mysalesData,
  breakdownData,
  analyticsData,
  commissionData,
  payData,
  jobData,
  setupData,
  settingsData
].map(c => c.toJSON());

const rest = new REST().setToken(token);

async function deploy() {
  try {
    console.log(`[TDC] Registering ${commands.length} slash commands globally...`);
    const data = await rest.put(Routes.applicationCommands(clientId), { body: commands }) as any[];
    console.log(`[TDC] ✅ Successfully registered ${data.length} commands.`);
  } catch (err) {
    console.error("[TDC] Failed to deploy commands:", err);
    process.exit(1);
  }
}

deploy();
