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
import { data as timeclockData,   execute as timeclockExecute   } from "./commands/timeclock.js";
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
  { data: clearData,       execute: clearExecute       },
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
    console.log(`[TDC] ✅ Registered ${result.length} commands: ${commandDefs.map(c => `/${c.data.name}`).join(", ")}`);
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

  // Weekly NEW WEEK message — every Monday to all sales channels
  scheduleNewWeekMessage(c);

  // Timeclock panel repost — every 45 minutes
  scheduleTimeclockPanelRepost(c);
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
  let firedThisWeek = false;

  const tick = async () => {
    const now = new Date();
    // Fire on Monday UTC between 00:00–00:05
    if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      if (firedThisWeek) return;
      firedThisWeek = true;
      console.log("[TDC] 💸 Running automatic Monday payday...");
      try {
        const { processPayall } = await import("./commands/payall.js");
        const { weekStart } = await import("./lib/utils.js");
        const ws = weekStart();

        const rows = await db.execute("SELECT guild_id, payday_channel_id, log_channel_id, orders_channel_id FROM guild_config");
        for (const row of rows.rows) {
          const guildId = String(row[0] ?? "");
          if (!guildId) continue;
          try {
            const guild = await client.guilds.fetch(guildId);
            const result = await processPayall(guild as any, ws, client.user!.id);
            if (!result) { console.log(`[TDC] 💸 No unpaid orders for guild ${guildId}`); continue; }

            const { grandCommission, totalRevenue, mechanicCount, totalToBill } = result;
            const { money } = await import("./lib/embeds.js");
            const { EmbedBuilder } = await import("discord.js");

            const announceChanId = (row[1] ?? row[2] ?? row[3]) ? String(row[1] ?? row[2] ?? row[3]) : null;
            if (announceChanId) {
              const ch = await guild.channels.fetch(announceChanId).catch(() => null);
              if (ch?.isTextBased()) {
                const paydayEmbed = new EmbedBuilder()
                  .setTitle("💸  IT'S PAYDAY! — NEW WEEK STARTS NOW")
                  .setColor(0xffd700)
                  .setDescription(
                    "# 🎉  PAYDAY IS HERE!\n\n" +
                    "All crew have been paid for this week's work.\n" +
                    "**Order numbers have been reset — fresh start for everyone!**\n\n" +
                    "> 💪 Keep grinding. New week, new money.\n" +
                    "> 📅 **Payday is every Monday** — stay clocked in, stay stacking."
                  )
                  .addFields(
                    { name: "👥 Crew Paid",              value: String(mechanicCount), inline: true },
                    { name: "💵 Total Revenue",           value: money(totalRevenue),   inline: true },
                    { name: "💰 Total Commissions Out",   value: money(grandCommission),inline: true },
                    { name: "🏢 Total Billed to Company", value: `**${money(totalToBill)}**`, inline: false }
                  )
                  .setFooter({ text: "東京ドリフトカスタム  ·  Built Different. Driven Hard." })
                  .setTimestamp();
                await (ch as any).send({ content: "@everyone", embeds: [paydayEmbed] });
              }
            }
            console.log(`[TDC] 💸 Auto-payday complete for guild ${guildId} — ${mechanicCount} crew, $${totalToBill.toFixed(0)} billed`);
          } catch (err) {
            console.error(`[TDC] Payday auto-run failed for guild ${guildId}:`, err);
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

// ── Monday NEW WEEK message scheduler ──────────────────────────────────────────
function scheduleNewWeekMessage(client: Client) {
  let firedThisWeek = false;

  const tick = async () => {
    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      if (firedThisWeek) return;
      firedThisWeek = true;
      console.log("[TDC] 📅 Sending NEW WEEK messages to all sales channels...");
      try {
        const profiles = await db.execute("SELECT discord_id, sales_channel_id FROM profiles WHERE sales_channel_id IS NOT NULL AND sales_channel_id != ''");
        for (const row of profiles.rows) {
          const salesChanId = row[1] ? String(row[1]) : null;
          if (!salesChanId) continue;
          try {
            const guilds = await db.execute("SELECT DISTINCT guild_id FROM guild_config");
            for (const gRow of guilds.rows) {
              const guildId = String(gRow[0] ?? "");
              if (!guildId) continue;
              try {
                const guild = await client.guilds.fetch(guildId);
                const ch = await guild.channels.fetch(salesChanId).catch(() => null);
                if (!ch?.isTextBased()) continue;
                await (ch as any).send({
                  content:
                    "# 🗓️  NEW WEEK — LET'S GET IT!\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    "> 💪 **Fresh start. New money. New orders.**\n" +
                    "> 🏁 Clock in and get grinding — it's a brand new week at **Tokyo Drift Customs!**\n" +
                    "> 📈 Make this week your best one yet.\n" +
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                });
                break;
              } catch { /* guild or channel not accessible */ }
            }
          } catch { /* ignore */ }
        }
        console.log("[TDC] 📅 NEW WEEK messages sent.");
      } catch (err) {
        console.error("[TDC] NEW WEEK scheduler error:", err);
      }
    } else {
      firedThisWeek = false;
    }
  };

  setInterval(tick, 5 * 60 * 1000);
  console.log("[TDC] 📅 NEW WEEK scheduler started (fires every Monday midnight UTC)");
}

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
  client.login(token!);
}).catch(err => {
  console.error("[TDC] ❌ DB init failed:", err);
  process.exit(1);
});
