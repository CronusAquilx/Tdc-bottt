import http from "http";
import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  MessageFlags,
  REST,
  Routes,
  ChatInputCommandInteraction,
  Status
} from "discord.js";
import { initDb } from "./db.js";
import { data as orderData,       execute as orderExecute       } from "./commands/order.js";
import { data as crewData,        execute as crewExecute        } from "./commands/crew.js";
import { data as timeclockData,      execute as timeclockExecute      } from "./commands/timeclock.js";
import { data as timeclockManageData, execute as timeclockManageExecute } from "./commands/timeclockmanage.js";
import { data as mysalesData,     execute as mysalesExecute     } from "./commands/mysales.js";
import { data as payData,         execute as payExecute         } from "./commands/pay.js";
import { data as payallData,      execute as payallExecute      } from "./commands/payall.js";
import { data as setpayData,      execute as setpayExecute      } from "./commands/setpay.js";
import { data as setupData,       execute as setupExecute       } from "./commands/setup.js";
import { data as settingsData,    execute as settingsExecute    } from "./commands/settings.js";
import { data as helpData,        execute as helpExecute        } from "./commands/help.js";
import { data as payoutData,      execute as payoutExecute      } from "./commands/payout.js";
import { data as loaData,         execute as loaExecute         } from "./commands/loa.js";
import { data as profileData,     execute as profileExecute     } from "./commands/profile.js";
import { data as leaderboardData, execute as leaderboardExecute } from "./commands/leaderboard.js";
import { data as setrankData,     execute as setrankExecute     } from "./commands/setrank.js";
import { data as managerData,     execute as managerExecute     } from "./commands/manager.js";
import { data as clearData,       execute as clearExecute       } from "./commands/clear.js";
import { data as newweekData,     execute as newweekExecute     } from "./commands/newweek.js";
import { handleButton }        from "./interactions/buttons.js";
import { handleDraftButton }   from "./interactions/draftbuttons.js";
import { handleModal }         from "./interactions/modals.js";
import { handleSelect }        from "./interactions/selects.js";
import { handleAdminButton }   from "./interactions/adminbuttons.js";
import { handleAdminModal }    from "./interactions/adminmodals.js";
import { handleRaffleButton, handleRaffleModal } from "./interactions/raffle.js";
import { handleLoaButton, handleLoaModal }       from "./interactions/loa.js";
import { handleTrainingButton, handleTrainingModal } from "./interactions/training.js";
import { handleBankButton, handleBankModal, scheduleDailyBankPrompts } from "./interactions/bankaccount.js";
import { postLoaPanel, postRafflePanel } from "./interactions/adminbuttons.js";
import { postLeaderboard }                       from "./commands/leaderboard.js";
import { startAutoClockOutMonitor }              from "./lib/autoClockOut.js";
import { db } from "./db.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[TDC] ❌ DISCORD_TOKEN is not set. Add it to this service's environment variables (Replit Secrets or Render Environment).");
  process.exit(1);
}

// ── Process recovery ───────────────────────────────────────────────────────────
// Render restarts a worker after it exits. Prefer a clean restart over leaving
// a process alive with a broken gateway or an unhandled async failure.
let restartTimer: ReturnType<typeof setTimeout> | null = null;
function restartProcess(reason: string) {
  if (restartTimer) return;
  console.error(`[TDC] 🔁 Restarting process: ${reason}`);
  restartTimer = setTimeout(() => process.exit(1), 1000);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[TDC] 💥 Unhandled promise rejection:", reason);
  restartProcess("unhandled promise rejection");
});

process.on("uncaughtException", (err: Error) => {
  console.error("[TDC] 💥 Uncaught exception:", err);
  restartProcess("uncaught exception");
});

// Active by default — set BOT_ENABLED=false to disable (e.g. for local testing without Discord).
const BOT_ACTIVE = process.env.BOT_ENABLED !== "false";
if (!BOT_ACTIVE) {
  console.log("[TDC] ⚠️  BOT_ENABLED=false — running health server only.");
}

const tokenParts = token.split(".");
const clientId = Buffer.from(tokenParts[0], "base64").toString("utf-8");

// ── Health server ──────────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.PORT ?? process.env.BOT_HTTP_PORT ?? "3001", 10);
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
  console.log(`[TDC] 🌐 Health server on port ${HTTP_PORT}`);
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
  { data: orderData,       execute: orderExecute       },
  { data: crewData,        execute: crewExecute        },
  { data: timeclockData,   execute: timeclockExecute   },
  { data: mysalesData,     execute: mysalesExecute     },
  { data: payData,         execute: payExecute         },
  { data: payallData,      execute: payallExecute      },
  { data: setpayData,      execute: setpayExecute      },
  { data: setupData,       execute: setupExecute       },
  { data: settingsData,    execute: settingsExecute    },
  { data: helpData,        execute: helpExecute        },
  { data: payoutData,      execute: payoutExecute      },
  { data: loaData,         execute: loaExecute         },
  { data: profileData,     execute: profileExecute     },
  { data: leaderboardData, execute: leaderboardExecute },
  { data: setrankData,     execute: setrankExecute     },
  { data: managerData,     execute: managerExecute     },
  { data: clearData,            execute: clearExecute            },
  { data: newweekData,          execute: newweekExecute          },
  { data: timeclockManageData,  execute: timeclockManageExecute  },
];

const commands = new Collection<string, { execute: (i: ChatInputCommandInteraction) => Promise<void> }>();
for (const cmd of commandDefs) {
  commands.set(cmd.data.name, { execute: cmd.execute });
}


client.once(Events.ClientReady, async (c) => {
  console.log(`[TDC] 🏁 Logged in as ${c.user.tag}`);
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const body = commandDefs.map(c => c.data.toJSON());
  try {
    const rest = new REST().setToken(token!);
    if (guildId) {
      console.log(`[TDC] ⚡ Registering ${commandDefs.length} commands to guild ${guildId} (instant)...`);
      const result = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body }) as any[];
      console.log(`[TDC] ✅ Guild commands registered instantly (${result.length}): ${commandDefs.map(c => `/${c.data.name}`).join(", ")}`);
      try {
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        console.log(`[TDC] 🧹 Cleared global commands (using guild-only mode).`);
      } catch { /* ignore */ }
    } else {
      console.log(`[TDC] 🔧 Registering ${commandDefs.length} slash commands globally (up to 1hr propagation)...`);
      const result = await rest.put(Routes.applicationCommands(clientId), { body }) as any[];
      console.log(`[TDC] ✅ Registered ${result.length} commands: ${commandDefs.map(c => `/${c.data.name}`).join(", ")}`);
    }
  } catch (err) {
    console.error("[TDC] ❌ Failed to register commands:", err);
  }

  // Auto-post panels to configured channels that are missing them
  try {
    const rows = await db.execute("SELECT guild_id, loa_channel_id, raffle_channel_id, bank_account_channel_id FROM guild_config");
    for (const row of rows.rows) {
      const guildId      = String(row[0] ?? "");
      const loaChanId    = row[1] ? String(row[1]) : null;
      const raffleChanId = row[2] ? String(row[2]) : null;
      const bankChanId   = row[3] ? String(row[3]) : null;
      if (!guildId) continue;

      let guild: any;
      try { guild = await c.guilds.fetch(guildId); } catch { continue; }

      for (const [chanId, panelFn, label] of [
        [loaChanId,    postLoaPanel,    "LOA"],
        [raffleChanId, postRafflePanel, "Raffle"],
        [bankChanId,   async (ch: any) => {
          const { postBankAccountPanel } = await import("./interactions/bankaccount.js");
          return postBankAccountPanel(ch, guild.id);
        }, "Bank Account"],
      ] as [string | null, (ch: any) => Promise<any>, string][]) {
        if (!chanId) continue;
        try {
          const ch = await guild.channels.fetch(chanId);
          if (!ch?.isTextBased()) continue;
          const recent = await ch.messages.fetch({ limit: 10 });
          const botAlreadyPosted = [...recent.values()].some((m: any) => m.author?.id === c.user.id);
          if (botAlreadyPosted) {
            console.log(`[TDC] ✅ ${label} panel already present in #${ch.name}`);
            continue;
          }
          await panelFn(ch);
          console.log(`[TDC] 📌 Posted ${label} panel to #${ch.name}`);
        } catch (err) {
          console.error(`[TDC] ⚠️ Failed to post ${label} panel:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[TDC] ⚠️ Panel auto-post error:", err);
  }

  // Start auto clock-out monitor (every 5 min, idle threshold)
  startAutoClockOutMonitor(c);
  scheduleDailyBankPrompts(c);

  // Weekly leaderboard auto-post — every Monday at midnight UTC
  scheduleWeeklyLeaderboard(c);
});


// ── Discord gateway error / disconnect events ──────────────────────────────────
client.on(Events.Error, (err) => {
  console.error("[TDC] 🔌 Discord client error:", err);
});

client.on(Events.ShardError, (err, id) => {
  console.error(`[TDC] 🔌 Discord shard ${id} error:`, err);
});

client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`[TDC] 🔌 Shard ${id} disconnected (code ${event.code}) — watching reconnect.`);
});

client.on(Events.ShardReconnecting, (id) => {
  console.log(`[TDC] 🔄 Shard ${id} reconnecting to Discord...`);
});

client.on(Events.ShardResume, (id, replayed) => {
  console.log(`[TDC] ✅ Shard ${id} resumed (${replayed} events replayed).`);
});

client.on(Events.Invalidated, () => {
  // Discord will not recover an invalidated session by itself.
  restartProcess("Discord invalidated the gateway session");
});

function startGatewayWatchdog() {
  const CHECK_EVERY_MS = 60_000;
  const MAX_UNHEALTHY_MS = 5 * 60_000;
  let unhealthySince: number | null = null;

  setInterval(() => {
    const gatewayReady =
      client.isReady() &&
      client.ws.status === Status.Ready &&
      client.ws.ping >= 0;

    if (gatewayReady) {
      if (unhealthySince !== null) {
        console.log(`[TDC] ✅ Discord gateway recovered (ping ${client.ws.ping}ms).`);
      }
      unhealthySince = null;
      return;
    }

    if (unhealthySince === null) {
      unhealthySince = Date.now();
      console.warn(
        `[TDC] ⚠️ Discord gateway is not ready (status ${client.ws.status}, ping ${client.ws.ping}).`
      );
      return;
    }

    const unhealthyFor = Date.now() - unhealthySince;
    if (unhealthyFor >= MAX_UNHEALTHY_MS) {
      restartProcess(
        `Discord gateway stayed unhealthy for ${Math.round(unhealthyFor / 60_000)} minutes`
      );
    }
  }, CHECK_EVERY_MS);

  console.log("[TDC] 🩺 Discord gateway watchdog started (60s checks, 5m recovery window)");
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (await handleAdminButton(interaction)) return;
      if (await handleBankButton(interaction)) return;
      if (await handleRaffleButton(interaction)) return;
      if (await handleLoaButton(interaction)) return;
      if (await handleTrainingButton(interaction)) return;
      if (await handleDraftButton(interaction)) return;
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (await handleAdminModal(interaction)) return;
      if (await handleBankModal(interaction)) return;
      if (await handleRaffleModal(interaction)) return;
      if (await handleLoaModal(interaction)) return;
      if (await handleTrainingModal(interaction)) return;
      await handleModal(interaction);
      return;
    }

    if (interaction.isAnySelectMenu()) {
      await handleSelect(interaction);
      return;
    }
  } catch (err: any) {
    const code = err?.code ?? err?.rawError?.code;
    if (code === 10062) {
      // Stale interaction — expected on restart, not a real error. Silently drop.
      return;
    }
    if (code === 40060) {
      // Already acknowledged (duplicate event or double-fire). Silently drop.
      return;
    }

    console.error("[TDC] Interaction error:", err);
    try {
      const msg = { content: "⚠️ Something went wrong. Please try again.", flags: MessageFlags.Ephemeral };
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

// ── Weekly leaderboard scheduler ───────────────────────────────────────────────
function scheduleWeeklyLeaderboard(client: Client) {
  const tick = async () => {
    const now = new Date();
    // Fire on Monday UTC between 00:00–00:05
    if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      try {
        const rows = await db.execute("SELECT guild_id, leaderboard_channel_id FROM guild_config WHERE leaderboard_channel_id IS NOT NULL");
        for (const row of rows.rows) {
          const guildId   = String(row[0] ?? "");
          const channelId = row[1] ? String(row[1]) : null;
          if (!guildId || !channelId) continue;
          try {
            const guild = await client.guilds.fetch(guildId);
            const ch    = await guild.channels.fetch(channelId).catch(() => null);
            if (!ch?.isTextBased()) continue;
            await postLeaderboard(ch as any);
            console.log(`[TDC] 🏆 Auto-posted weekly leaderboard for guild ${guildId}`);
          } catch (err: any) {
            if (err?.code === 10004) {
              // Bot is no longer in this guild — remove stale config
              console.warn(`[TDC] 🏆 Bot no longer in guild ${guildId} — removing stale config row.`);
              await db.execute({ sql: "DELETE FROM guild_config WHERE guild_id = ?", args: [guildId] }).catch(() => {});
            } else {
              console.error(`[TDC] Leaderboard auto-post failed for guild ${guildId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error("[TDC] Leaderboard scheduler error:", err);
      }
    }
  };

  // Check every 5 minutes
  setInterval(tick, 5 * 60 * 1000);
  console.log("[TDC] 🏆 Leaderboard scheduler started (checks every 5 min, fires Monday midnight UTC)");
}

// ── NOTE: Payday and new-week are MANUAL only ──────────────────────────────────
// Use /payall or the 📅 Pay All button in the admin panel to run payroll.
// Use /newweek or the NEW WEEK button to send new-week messages.
// No auto-schedules exist for these — everything is triggered by you.

initDb().then(() => {
  if (BOT_ACTIVE) {
    startGatewayWatchdog();
    client.login(token!).catch((err: unknown) => {
      console.error("[TDC] ❌ Discord login failed:", err);
      // A bot that cannot authenticate must stop so Render restarts it and
      // surfaces the real error instead of keeping only the health server up.
      restartProcess("Discord login failed");
    });
  } else {
    console.log("[TDC] 🛑 Bot login skipped (BOT_ENABLED=false). Health server is running.");
  }
}).catch(err => {
  console.error("[TDC] ❌ DB init failed:", err);
  process.exit(1);
});
