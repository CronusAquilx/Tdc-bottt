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
import { data as orderData,       execute as orderExecute       } from "./commands/order.js";
import { data as crewData,        execute as crewExecute        } from "./commands/crew.js";
import { data as timeclockData,      execute as timeclockExecute      } from "./commands/timeclock.js";
import { data as timeclockManageData, execute as timeclockManageExecute } from "./commands/timeclockmanage.js";
import { data as mysalesData,     execute as mysalesExecute     } from "./commands/mysales.js";
import { data as payData,         execute as payExecute         } from "./commands/pay.js";
import { data as payallData,      execute as payallExecute      } from "./commands/payall.js";
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
import { data as setpayData,      execute as setpayExecute      } from "./commands/setpay.js";
import { handleButton }        from "./interactions/buttons.js";
import { handleDraftButton }   from "./interactions/draftbuttons.js";
import { handleModal }         from "./interactions/modals.js";
import { handleSelect }        from "./interactions/selects.js";
import { handleAdminButton }   from "./interactions/adminbuttons.js";
import { handleAdminModal }    from "./interactions/adminmodals.js";
import { handleRaffleButton, handleRaffleModal } from "./interactions/raffle.js";
import { handleLoaButton, handleLoaModal }       from "./interactions/loa.js";
import { handleTrainingButton, handleTrainingModal } from "./interactions/training.js";
import { postLoaPanel, postRafflePanel, postTimeclockPanel } from "./interactions/adminbuttons.js";
import { postLeaderboard }                       from "./commands/leaderboard.js";
import { startAutoClockOutMonitor }              from "./lib/autoClockOut.js";
import { db } from "./db.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[TDC] ❌ DISCORD_TOKEN is not set. Add it to Replit Secrets.");
  process.exit(1);
}

// ── Global crash guards ────────────────────────────────────────────────────────
// Log all unhandled rejections so they appear in Render logs instead of
// disappearing silently. Node 18+ exits on unhandledRejection by default;
// we intercept, log, then let the normal exit happen so Render can restart.
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[TDC] 💥 Unhandled promise rejection:", reason);
  // Do NOT suppress — let Node exit so the supervisor restarts the process cleanly.
});

// Uncaught exceptions leave the process in an undefined state.
// Log clearly then exit(1) so Render's supervisor restarts us immediately.
process.on("uncaughtException", (err: Error) => {
  console.error("[TDC] 💥 Uncaught exception — restarting:", err);
  // Short delay to flush the log line before the process dies.
  setTimeout(() => process.exit(1), 500);
});

// Guard: only connect to Discord when running on Render (the live deployment).
// This prevents the Replit dev environment from spinning up a second bot instance
// that would cause duplicate command responses and double event handling.
// Set BOT_ENABLED=true on Render to allow the connection.
// Render also automatically sets RENDER=true for all its services.
const BOT_ACTIVE = process.env.BOT_ENABLED === "true" || process.env.RENDER === "true";
if (!BOT_ACTIVE) {
  console.log("[TDC] ⚠️  Not on Render — running health server only. Set BOT_ENABLED=true or deploy to Render to activate the bot.");
}

const tokenParts = token.split(".");
const clientId = Buffer.from(tokenParts[0], "base64").toString("utf-8");

// ── Health server ──────────────────────────────────────────────────────────────
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
  { data: setpayData,           execute: setpayExecute           },
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
      // Clear any leftover global commands so users don't see duplicates
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
    const rows = await db.execute("SELECT guild_id, loa_channel_id, raffle_channel_id FROM guild_config");
    for (const row of rows.rows) {
      const guildId      = String(row[0] ?? "");
      const loaChanId    = row[1] ? String(row[1]) : null;
      const raffleChanId = row[2] ? String(row[2]) : null;
      if (!guildId) continue;

      let guild: any;
      try { guild = await c.guilds.fetch(guildId); } catch { continue; }

      for (const [chanId, panelFn, label] of [
        [loaChanId,    postLoaPanel,    "LOA"],
        [raffleChanId, postRafflePanel, "Raffle"],
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

  // Start auto clock-out monitor (every 5 min, 20 min idle threshold)
  startAutoClockOutMonitor(c);

  // Weekly leaderboard auto-post — every Monday at midnight UTC
  scheduleWeeklyLeaderboard(c);

  // Weekly auto-payday — every Monday at midnight UTC
  scheduleWeeklyPayday(c);

  // Timeclock panel repost — every 45 minutes
  scheduleTimeclockPanelRepost(c);
});


// ── Discord gateway error / disconnect events ──────────────────────────────────
client.on(Events.Error, (err) => {
  console.error("[TDC] 🔌 Discord client error:", err);
});

client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`[TDC] 🔌 Shard ${id} disconnected (code ${event.code}) — Discord.js will auto-reconnect.`);
});

client.on(Events.ShardReconnecting, (id) => {
  console.log(`[TDC] 🔄 Shard ${id} reconnecting to Discord...`);
});

client.on(Events.ShardResume, (id, replayed) => {
  console.log(`[TDC] ✅ Shard ${id} resumed (${replayed} events replayed).`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (await handleAdminButton(interaction)) return;
      if (await handleRaffleButton(interaction)) return;
      if (await handleLoaButton(interaction)) return;
      if (await handleTrainingButton(interaction)) return;
      if (await handleDraftButton(interaction)) return;
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (await handleAdminModal(interaction)) return;
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

// ── Weekly payday scheduler ─────────────────────────────────────────────────────
function scheduleWeeklyPayday(client: Client) {
  // In-memory guard: prevents double-fire within a single process run.
  // DB guard below: prevents double-fire across restarts (survives crashes).
  let firedThisWeek = false;

  const tick = async () => {
    const now = new Date();
    // Fire on Monday UTC between 00:00–00:05
    if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      if (firedThisWeek) return;

      // ── DB-backed deduplication (survives bot restarts) ───────────────────────
      // If the bot crashes and restarts on Monday morning, firedThisWeek resets to
      // false and the scheduler would fire again — wiping all /setpay adjustments.
      // We persist the run date in app_settings so a restart never double-fires.
      const { getSetting, setSetting } = await import("./db.js");
      const todayStr = now.toISOString().split("T")[0]; // "2026-06-30"
      try {
        const lastRun = await getSetting("last_auto_payday_date");
        if (lastRun === todayStr) {
          firedThisWeek = true; // sync flag so we stop checking
          console.log(`[TDC] 💸 Auto-payday already ran today (${todayStr}) — skipping.`);
          return;
        }
        // We do NOT write the dedup key here — we write it AFTER the work
        // completes. If the bot crashes mid-run, the next restart retries safely:
        // processPayall only touches orders with status 'complete'/'approved',
        // so it's idempotent for orders already marked 'paid'.
      } catch (err) {
        console.error("[TDC] ⚠️ Could not read last_auto_payday_date — skipping auto-payday to be safe:", err);
        return;
      }

      firedThisWeek = true;
      console.log("[TDC] 💸 Running automatic Monday payday...");
      try {
        const { processPayall, postPayLogPanel } = await import("./commands/payall.js");
        const { postOrderPanel } = await import("./interactions/orderpanel.js");
        const { weekStart } = await import("./lib/utils.js");
        const { money } = await import("./lib/embeds.js");
        const { EmbedBuilder } = await import("discord.js");
        const ws = weekStart();

        const rows = await db.execute("SELECT guild_id, payday_channel_id FROM guild_config");
        let anyGuildProcessed = false;
        for (const row of rows.rows) {
          const guildId      = String(row[0] ?? "");
          const payLogsChanId = row[1] ? String(row[1]) : null;
          if (!guildId) continue;
          try {
            const guild  = await client.guilds.fetch(guildId);
            const result = await processPayall(guild as any, ws, client.user!.id);
            anyGuildProcessed = true;

            if (!result) {
              console.log(`[TDC] 💸 No unpaid orders for guild ${guildId} — sending new week only`);
              // Still send new week + fresh order panel even if no orders to pay
              const profiles = await db.execute(
                "SELECT discord_id, sales_channel_id, display_name, commission_rate FROM profiles WHERE sales_channel_id IS NOT NULL AND sales_channel_id != ''"
              );
              for (const pr of profiles.rows) {
                const salesChanId = pr[1] ? String(pr[1]) : null;
                if (!salesChanId) continue;
                try {
                  const ch = await guild.channels.fetch(salesChanId).catch(() => null);
                  if (!ch?.isTextBased()) continue;
                  await (ch as any).send({
                    content:
                      "# 🗓️  NEW WEEK — LET'S GET IT!\n" +
                      "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                      "> 💪 **Fresh start. New money. New orders.**\n" +
                      "> 🏁 Clock in and get grinding — it's a brand new week at **Tokyo Drift Customs!**\n" +
                      "> 📅 **Payday is every Monday** — stay clocked in, stay stacking.\n" +
                      "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                  });
                  await postOrderPanel(ch as any, String(pr[0] ?? ""), String(pr[2] ?? ""), Number(pr[3] ?? 0.3));
                } catch { /* ignore */ }
              }
              continue;
            }

            const { grandCommission, totalRevenue, mechanicCount, totalToBill, payouts } = result;

            // Notify each mechanic in their personal sales channel
            let notified = 0;
            for (const p of payouts) {
              if (!p.salesChanId) continue;
              try {
                const ch = await guild.channels.fetch(p.salesChanId).catch(() => null);
                if (!ch?.isTextBased()) continue;
                await (ch as any).send({
                  content:
                    `# 💸  PAYDAY — ${p.name.toUpperCase()}!\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `> 📋 **${p.orders} orders** completed this week\n` +
                    (p.hours > 0 ? `> ⏱️ **${p.hours.toFixed(1)} hours** worked this week\n` : "") +
                    `> 💰 Commission rate: **${(p.rate * 100).toFixed(0)}%**\n` +
                    `> 💵 **Your commission this week: ${money(p.amount)}**\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `**Bill the company: ${money(p.amount)}** 🏢\n` +
                    `Keep grinding, ${p.name}! 🏁`
                });
                await (ch as any).send({
                  content:
                    "# 🗓️  NEW WEEK — LET'S GET IT!\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    "> 💪 **Fresh start. New money. New orders.**\n" +
                    "> 🏁 Clock in and get grinding — it's a brand new week at **Tokyo Drift Customs!**\n" +
                    "> 📅 **Payday is every Monday** — stay clocked in, stay stacking.\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                });
                const { getProfile } = await import("./db.js");
                const profile = await getProfile(p.mechanicId);
                await postOrderPanel(ch as any, p.mechanicId, profile?.display_name ?? p.name, profile?.commission_rate ?? p.rate);
                notified++;
              } catch { /* ignore */ }
            }

            // Post payroll log to the pay-logs channel
            if (payLogsChanId) {
              try {
                const ch = await guild.channels.fetch(payLogsChanId).catch(() => null);
                if (ch?.isTextBased()) {
                  const payLines = payouts.map(p => {
                    const hrsNote = p.hours > 0 ? ` · ${p.hours.toFixed(1)}h` : "";
                    return `**${p.name}** · ${p.orders} orders${hrsNote} · ${(p.rate * 100).toFixed(0)}% → **${money(p.amount)}**`;
                  });
                  const logEmbed = new EmbedBuilder()
                    .setTitle("💸  AUTO PAYDAY — New Week Started")
                    .setColor(0xffd700)
                    .setDescription(
                      `**Pay period:** Week of \`${ws}\`\n` +
                      `**Total revenue:** ${money(totalRevenue)}\n\n` +
                      `✅ Pay messages sent to **${notified}** mechanic(s).`
                    )
                    .addFields(
                      { name: `🔩 Crew Paid (${mechanicCount})`,    value: payLines.join("\n") || "None", inline: false },
                      { name: "💰 Total Commission Out",             value: money(grandCommission),        inline: true  },
                      { name: "🏢 Total Billed to Company",         value: `**${money(totalToBill)}**`,   inline: true  }
                    )
                    .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
                    .setTimestamp();
                  await (ch as any).send({ embeds: [logEmbed] });
                }
              } catch { /* ignore */ }
            }

            console.log(`[TDC] 💸 Auto-payday complete for guild ${guildId} — ${mechanicCount} crew, ${totalToBill.toFixed(0)} billed, ${notified} notified`);
          } catch (err) {
            console.error(`[TDC] Payday auto-run failed for guild ${guildId}:`, err);
          }
        }

        // Write dedup key AFTER all payroll work completes.
        // If the bot crashed mid-run above, the key won't be written and the next
        // restart will safely retry (processPayall only acts on unpaid orders).
        if (anyGuildProcessed) {
          try {
            await setSetting("last_auto_payday_date", todayStr);
            console.log(`[TDC] 💸 Auto-payday dedup key written for ${todayStr}.`);
          } catch (e) {
            console.error("[TDC] ⚠️ Failed to write last_auto_payday_date:", e);
          }
        }
      } catch (err) {
        console.error("[TDC] Payday scheduler error:", err);
      }
    } else {
      firedThisWeek = false; // Reset so it fires again next Monday
    }
  };

  setInterval(tick, 5 * 60 * 1000);
  console.log("[TDC] 💸 Payday scheduler started (fires every Monday midnight UTC)");
}

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
          } catch (err) {
            console.error(`[TDC] Leaderboard auto-post failed for guild ${guildId}:`, err);
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

// NOTE: NEW WEEK messages + order panel re-post are handled by scheduleWeeklyPayday above.

// ── Timeclock panel repost scheduler ───────────────────────────────────────────
// Module-level timer guard — prevents duplicate intervals if the Ready event
// fires more than once (Discord.js reconnects).
let timeclockRepostTimer: ReturnType<typeof setInterval> | null = null;
const TIMECLOCK_PANEL_TITLE = "⏰  SHIFT LOG  ·  MANAGEMENT ONLY";

async function scheduleTimeclockPanelRepost(client: Client) {
  // Clear any existing timer so reconnects don't stack intervals
  if (timeclockRepostTimer) {
    clearInterval(timeclockRepostTimer);
    timeclockRepostTimer = null;
  }

  const repost = async () => {
    try {
      const rows = await db.execute("SELECT guild_id, timeclock_channel_id FROM guild_config WHERE timeclock_channel_id IS NOT NULL");
      for (const row of rows.rows) {
        const guildId   = String(row[0] ?? "");
        const channelId = row[1] ? String(row[1]) : null;
        if (!guildId || !channelId) continue;
        try {
          const guild = await client.guilds.fetch(guildId);
          const ch    = await guild.channels.fetch(channelId).catch(() => null);
          if (!ch?.isTextBased()) continue;

          // Detect previous timeclock HEADER panels by their embed title.
          // Do NOT check button customIds — the timeclock panel has no buttons.
          // Do NOT delete shift-record messages (they have different embed titles).
          const recent = await (ch as any).messages.fetch({ limit: 50 });
          const panelMsgs = [...recent.values()].filter((m: any) => {
            if (m.author?.id !== client.user?.id) return false;
            return m.embeds?.some((e: any) => e.title === TIMECLOCK_PANEL_TITLE);
          });

          // If a panel already exists and was posted within the last 2.5 hours,
          // skip the repost — nothing has changed.
          const newest = panelMsgs.sort((a: any, b: any) => b.createdTimestamp - a.createdTimestamp)[0];
          const twoAndHalfHoursMs = 2.5 * 60 * 60 * 1000;
          if (newest && (Date.now() - newest.createdTimestamp) < twoAndHalfHoursMs) {
            continue;
          }

          // Delete old header panels (not shift records)
          for (const m of panelMsgs) {
            try { await (m as any).delete(); } catch { /* ignore */ }
          }

          await postTimeclockPanel(ch as any);
          console.log(`[TDC] ⏰ Reposted timeclock panel in #${(ch as any).name}`);
        } catch (err) {
          console.error(`[TDC] Timeclock repost failed for guild ${guildId}:`, err);
        }
      }
    } catch (err) {
      console.error("[TDC] Timeclock repost scheduler error:", err);
    }
  };

  // Run every 3 hours
  timeclockRepostTimer = setInterval(repost, 3 * 60 * 60 * 1000);
  console.log("[TDC] ⏰ Timeclock panel repost scheduler started (every 3 hours)");
}

initDb().then(() => {
  if (BOT_ACTIVE) {
    client.login(token!);
  } else {
    console.log("[TDC] 🛑 Bot login skipped (not on Render). Health server is running.");
  }
}).catch(err => {
  console.error("[TDC] ❌ DB init failed:", err);
  process.exit(1);
});
