import http from "http";
import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
  ChatInputCommandInteraction
} from "discord.js";
import { initDb } from "./db.js";
import { data as orderData, execute as orderExecute } from "./commands/order.js";
import { data as crewData, execute as crewExecute } from "./commands/crew.js";
import { data as timeclockData, execute as timeclockExecute } from "./commands/timeclock.js";
import { data as mysalesData, execute as mysalesExecute } from "./commands/mysales.js";
import { data as payData, execute as payExecute } from "./commands/pay.js";
import { data as jobData, execute as jobExecute } from "./commands/job.js";
import { data as setupData, execute as setupExecute } from "./commands/setup.js";
import { data as settingsData, execute as settingsExecute } from "./commands/settings.js";
import { data as helpData, execute as helpExecute } from "./commands/help.js";
import { data as payoutData, execute as payoutExecute } from "./commands/payout.js";
import { handleButton } from "./interactions/buttons.js";
import { handleDraftButton } from "./interactions/draftbuttons.js";
import { handleModal } from "./interactions/modals.js";
import { handleSelect } from "./interactions/selects.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[TDC] ❌ DISCORD_TOKEN is not set. Add it to Replit Secrets.");
  process.exit(1);
}

const tokenParts = token.split(".");
const clientId = Buffer.from(tokenParts[0], "base64").toString("utf-8");

// ── Health server ─────────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.BOT_HTTP_PORT ?? "3001", 10);
const httpServer = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "Tokyo Drift Customs Bot", ts: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[TDC] ⚠️ Port ${HTTP_PORT} in use — health server skipped.`);
  } else {
    console.error("[TDC] HTTP server error:", err);
  }
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`[TDC] 🌐 Health server listening on port ${HTTP_PORT} — /healthz`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const commandDefs = [
  { data: orderData,    execute: orderExecute },
  { data: crewData,     execute: crewExecute },
  { data: timeclockData, execute: timeclockExecute },
  { data: mysalesData,  execute: mysalesExecute },
  { data: payData,      execute: payExecute },
  { data: jobData,      execute: jobExecute },
  { data: setupData,    execute: setupExecute },
  { data: settingsData, execute: settingsExecute },
  { data: helpData,     execute: helpExecute },
  { data: payoutData,   execute: payoutExecute }
];

const commands = new Collection<string, { execute: (i: ChatInputCommandInteraction) => Promise<void> }>();
for (const cmd of commandDefs) {
  commands.set(cmd.data.name, { execute: cmd.execute });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[TDC] 🏁 Logged in as ${c.user.tag}`);
  console.log(`[TDC] 🔧 Registering ${commandDefs.length} slash commands globally...`);
  try {
    const rest = new REST().setToken(token!);
    const body = commandDefs.map(c => c.data.toJSON());
    const result = await rest.put(Routes.applicationCommands(clientId), { body }) as any[];
    console.log(`[TDC] ✅ Registered ${result.length} commands.`);
    console.log(`[TDC] ✅ Online — ${commandDefs.map(c => `/${c.data.name}`).join(", ")}`);
  } catch (err) {
    console.error("[TDC] ❌ Failed to register commands:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }
    if (interaction.isButton()) {
      const handled = await handleDraftButton(interaction);
      if (!handled) await handleButton(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }
    if (interaction.isAnySelectMenu()) {
      await handleSelect(interaction);
      return;
    }
  } catch (err) {
    console.error("[TDC] Interaction error:", err);
    try {
      const msg = { content: "⚠️ Something went wrong. Please try again.", ephemeral: true as const };
      if (interaction.isRepliable()) {
        if ((interaction as any).replied || (interaction as any).deferred) {
          await (interaction as any).followUp(msg);
        } else {
          await (interaction as any).reply(msg);
        }
      }
    } catch { /* ignore */ }
  }
});

initDb().then(() => {
  client.login(token!);
}).catch(err => {
  console.error("[TDC] ❌ DB init failed:", err);
  process.exit(1);
});
