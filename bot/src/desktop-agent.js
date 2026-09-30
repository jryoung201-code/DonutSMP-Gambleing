import mineflayer from "mineflayer";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_API_URL = "https://donutsmp-game-hub-api.onrender.com";
const serverHost = process.env.MC_SERVER_HOST || "donutsmp.net";
const serverPort = Number(process.env.MC_SERVER_PORT || 25565);
const profileDir = path.join(process.env.LOCALAPPDATA || os.homedir(), "DonutSMPGameHub", "minecraft-auth");
const rl = readline.createInterface({ input, output });

function askHidden(question) {
  return new Promise(resolve => {
    output.write(question);
    const chars = [];
    const onData = buffer => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          input.off("data", onData);
          if (input.isTTY) input.setRawMode(false);
          output.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (char === "\u0003") { input.off("data", onData); if (input.isTTY) input.setRawMode(false); process.exit(130); }
        if (char === "\u007f" || char === "\b") { chars.pop(); continue; }
        chars.push(char);
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.on("data", onData);
  });
}

async function main() {
  if (process.argv.includes("--self-check")) {
    console.log("DonutSMP Desktop Bot executable is ready.");
    process.exit(0);
  }
  output.write("DonutSMP Desktop Bot\nThis app connects to DonutSMP from this PC. Keep it open while the bot is online.\n\n");
  const urlInput = (await rl.question(`Backend URL [${DEFAULT_API_URL}]: `)).trim();
  const backend = (urlInput || DEFAULT_API_URL).replace(/\/+$/, "");
  const backendUrl = new URL(backend);
  if (backendUrl.origin !== DEFAULT_API_URL && !["http://127.0.0.1:10000", "http://localhost:10000"].includes(backendUrl.origin)) {
    throw new Error("Use the official DonutSMP backend URL shown above.");
  }
  const password = await askHidden("Admin password (hidden): ");
  rl.close();
  if (!password) throw new Error("Admin password is required.");

  const origin = new URL(backend).origin;
  let cookie = "";
  const signIn = async () => {
    const login = await fetch(backend + "/api/admin/password-login", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ password })
    });
    const loginData = await login.json().catch(() => ({}));
    if (!login.ok) throw new Error(loginData.reason || "Could not sign in to the backend.");
    cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    if (!cookie.startsWith("gamehub_admin=")) throw new Error("Backend sign-in did not return an admin session.");
  };
  await signIn();
  const api = async (route, options = {}, retryAuth = true) => {
    const response = await fetch(backend + route, {
      ...options,
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && retryAuth) {
      await signIn();
      return api(route, options, false);
    }
    if (!response.ok) throw new Error(data.reason || `Backend request failed (${response.status}).`);
    return data;
  };

  await fs.mkdir(profileDir, { recursive: true });
  await api("/api/admin/desktop-bot/status", { method: "POST", body: JSON.stringify({ state: "starting", message: "Starting the desktop bot." }) });

  let bot;
  let activeJob = null;
  let stopped = false;
  let restarting = false;
  let securityBlocked = false;
  let reconnectDelay = 5000;
  let pollInProgress = false;
  let heartbeatTimer;
  let pollTimer;
  let reconnectTimer;
  let lastKickDetails = "";

  const messageText = message => {
    let value = "";
    try { value = typeof message === "string" ? message : JSON.stringify(message); } catch {}
    return value.replace(/§[0-9a-fk-or]/gi, "").toLowerCase();
  };
  const sendStatus = async (state, message, extras = {}) => {
    try {
      await api("/api/admin/desktop-bot/status", {
        method: "POST", body: JSON.stringify({ state, message, ...extras })
      });
    } catch (error) { console.error("Could not update admin bot status:", error.message); }
  };
  const finishJob = async (status, message) => {
    if (!activeJob) return;
    const job = activeJob;
    activeJob = null;
    clearTimeout(job.timeout);
    try {
      await api(`/api/admin/desktop-bot/jobs/${encodeURIComponent(job.jobId)}/result`, {
        method: "POST", body: JSON.stringify({ status, message: String(message).slice(0, 500) })
      });
    } catch (error) { console.error("Could not record payment result:", error.message); }
    console.log("Payment", status + ":", message);
  };

  const plainMessageText = message => {
    const visit = value => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(visit).join("");
      if (!value || typeof value !== "object") return "";
      let text = typeof value.text === "string" ? value.text : "";
      text += visit(value.extra || []);
      text += visit(value.with || []);
      text += visit(value.content || []);
      text += visit(value.json || []);
      return text;
    };
    const text = visit(message);
    return (text || (message && typeof message.toString === "function" ? message.toString() : ""))
      .replace(/§[0-9a-fk-or]/gi, "").replace(/\s+/g, " ").trim();
  };
  const parseIncomingPayment = message => {
    const text = plainMessageText(message);
    const patterns = [
      { regex: /(?:^|\b)([A-Za-z0-9_]{3,16})\s+(?:paid you|sent you)\s+\D{0,8}?([\d,]+(?:\.\d+)?)\s*([kmbt]?)(?:\s*(?:coins?)?)?(?:[.!]|$)/i, player: 1, amount: 2, suffix: 3 },
      { regex: /(?:^|\b)([A-Za-z0-9_]{3,16})\s+paid\s+([A-Za-z0-9_]{3,16})\s+\D{0,8}?([\d,]+(?:\.\d+)?)\s*([kmbt]?)(?:\s*(?:coins?)?)?(?:[.!]|$)/i, player: 1, recipient: 2, amount: 3, suffix: 4 },
      { regex: /(?:^|\b)you\s+(?:received|were paid)\s+\D{0,8}?([\d,]+(?:\.\d+)?)\s*([kmbt]?)\s+from\s+([A-Za-z0-9_]{3,16})(?:[.!]|$)/i, player: 3, amount: 1, suffix: 2 },
      { regex: /(?:^|\b)received\s+\D{0,8}?([\d,]+(?:\.\d+)?)\s*([kmbt]?)\s+from\s+([A-Za-z0-9_]{3,16})(?:[.!]|$)/i, player: 3, amount: 1, suffix: 2 }
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (!match) continue;
      const numeric = Number(match[pattern.amount].replace(/,/g, ""));
      const suffix = (match[pattern.suffix] || "").toLowerCase();
      const amount = numeric * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suffix] || 1);
      if (!Number.isSafeInteger(amount) || amount < 1) return null;
      return { player: match[pattern.player], recipient: pattern.recipient ? match[pattern.recipient] : null, amount, text };
    }
    return null;
  };
  const incomingSeen = new Map();
  const inspectIncomingPayment = async (message, position, sender) => {
    const positionName = String(position || "").toLowerCase();
    if (sender || !["system", "game_info"].includes(positionName)) return;
    const payment = parseIncomingPayment(message);
    if (!payment || (payment.recipient && payment.recipient.toLowerCase() !== bot.username.toLowerCase())) return;
    const dedupeKey = payment.player.toLowerCase() + ":" + payment.amount;
    const now = Date.now();
    if (now - (incomingSeen.get(dedupeKey) || 0) < 1500) return;
    incomingSeen.set(dedupeKey, now);
    for (const [key, time] of incomingSeen) if (now - time > 10000) incomingSeen.delete(key);

    const requestId = crypto.randomUUID();
    try {
      const outcome = await api("/api/admin/desktop-bot/incoming-payment", {
        method: "POST",
        body: JSON.stringify({ requestId, player: payment.player, recipient: bot.username, amount: payment.amount })
      });
      const amountText = Number(outcome.amount).toLocaleString();
      if (outcome.result === "REFUND") {
        const messageText = payment.player + ", 50/50 is unavailable: " + (outcome.reason || "payment refunded") + "; " + Number(outcome.refund).toLocaleString() + " coins returned.";
        console.log(messageText);
        bot.chat(messageText);
      } else if (outcome.result === "WIN") {
        const messageText = payment.player + ", 50/50 WIN! " + Number(outcome.payout).toLocaleString() + " coins queued.";
        console.log(messageText, "(bet " + amountText + ")");
        bot.chat(messageText);
      } else {
        const messageText = payment.player + ", 50/50 LOSE. No payout.";
        console.log(messageText, "(bet " + amountText + ")");
        bot.chat(messageText);
      }
    } catch (error) {
      console.error("Could not process incoming payment:", error.message, payment.text);
    }
  };
  const inspectMessage = async message => {
    if (!activeJob) return;
    const text = messageText(message);
    if (/don't have enough funds|do not have enough funds|not enough funds|insufficient funds|not enough money/.test(text)) {
      await finishJob("rejected", text); return;
    }
    const player = activeJob.player.toLowerCase();
    if ((text.includes("paid") || text.includes("payment sent") || text.includes("you sent")) && text.includes(player)) {
      await finishJob("paid", text); return;
    }
    if ((text.includes("cannot pay") || text.includes("can't pay") || text.includes("invalid player") || text.includes("player not found")) && text.includes(player)) {
      await finishJob("rejected", text);
    }
  };
  const scheduleReconnect = delay => {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!stopped) startBot(); }, delay);
  };
  const startBot = () => {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    restarting = false;
    securityBlocked = false;
    sendStatus("starting", "Connecting to DonutSMP from this PC.");
    try {
      bot = mineflayer.createBot({
        host: serverHost,
        port: serverPort,
        username: "donutsmp-desktop-bot",
        auth: "microsoft",
        version: process.env.MC_VERSION || false,
        profilesFolder: profileDir,
        onMsaCode: code => {
          const userCode = code?.user_code || code?.userCode || null;
          const verificationUri = code?.verification_uri || code?.verificationUri || "https://www.microsoft.com/link";
          const text = typeof code?.message === "string" ? code.message : "Open Microsoft device sign-in and enter the code shown in the admin page.";
          console.log(text);
          if (userCode) console.log("Microsoft device code:", userCode);
          sendStatus("awaiting_code", text, { userCode, verificationUri, expiresIn: Number(code?.expires_in || code?.expiresIn) || 900 });
        },
        hideErrors: false
      });
      bot.on("connect", () => {
        console.log(`TCP connected to ${serverHost}:${serverPort}; waiting for Minecraft login.`);
        void sendStatus("connecting", "Connected to the server address; waiting for Minecraft login.");
      });
      bot.on("login", () => {
        console.log("Minecraft login accepted; waiting for DonutSMP to load the player.");
        void sendStatus("joining", "Minecraft accepted the account; waiting to enter the world.");
      });
      bot.on("spawn", async () => {
        reconnectDelay = 5000;
        const uuid = bot.player?.uuid || null;
        await sendStatus("connected", `Connected to DonutSMP as ${bot.username}.`, { username: bot.username, minecraftUuid: uuid });
        console.log("Connected to DonutSMP as", bot.username);
      });
      bot.on("message", (message, position, sender) => { void inspectMessage(message); void inspectIncomingPayment(message, position, sender); });
      bot.on("kicked", reason => {
        const details = messageText(reason);
        lastKickDetails = details.slice(0, 500);
        console.error("Minecraft server rejected the join:", details || "No kick reason provided.");
        if (activeJob) void finishJob("uncertain", "Disconnected while awaiting payment confirmation: " + details);
        if (/possible unauthorized login|for your own safety we've blocked it/.test(details)) {
          void sendStatus("blocked", "DonutSMP blocked this login. Confirm it using the bot account's Discord DM, then press Restart Bot / Rejoin in the admin page.");
          securityBlocked = true;
          restarting = false;
          return;
        }
        void sendStatus("disconnected", "The server kicked the bot: " + details.slice(0, 300));
      });
      bot.on("error", error => {
        console.error("Minecraft connection error:", error.message);
        void sendStatus("failed", "Minecraft sign-in or connection failed: " + error.message.slice(0, 250));
      });
      bot.on("end", reason => {
        const details = lastKickDetails || messageText(reason);
        if (details) console.error("Minecraft connection ended:", details.slice(0, 500));
        if (activeJob) void finishJob("uncertain", "Minecraft disconnected after dispatch; verify in game before retrying.");
        if (stopped || securityBlocked) return;
        if (restarting) return;
        void sendStatus("disconnected", details ? "Disconnected: " + details.slice(0, 300) : "Bot disconnected; trying to reconnect from this PC.");
        lastKickDetails = "";
        scheduleReconnect(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 120000);
      });
    } catch (error) {
      console.error("Could not start Minecraft bot:", error.message);
      void sendStatus("failed", error.message.slice(0, 250));
      scheduleReconnect(reconnectDelay);
    }
  };

  const poll = async () => {
    if (pollInProgress || stopped) return;
    pollInProgress = true;
    try {
      const control = await api("/api/admin/desktop-bot/control");
      if (control.restartRequested && !restarting) {
        restarting = true;
        clearTimeout(reconnectTimer);
        if (activeJob) await finishJob("uncertain", "Bot restart requested while awaiting server confirmation. Verify in game before retrying.");
        await sendStatus("starting", "Restarting the Minecraft connection from this PC.");
        try { bot?.quit("Admin requested restart"); } catch {}
        setTimeout(() => { if (!stopped && restarting) { restarting = false; startBot(); } }, 2500);
        await api("/api/admin/desktop-bot/control/ack", { method: "POST", body: "{}" });
      }
      if (bot?.player && !activeJob) {
        const next = await api("/api/admin/desktop-bot/jobs/claim", { method: "POST", body: "{}" });
        if (next.job) {
          activeJob = { ...next.job };
          activeJob.timeout = setTimeout(() => { void finishJob("uncertain", "No clear server response. Verify in game before retrying."); }, 20000);
          console.log(`Sending /pay ${activeJob.player} ${activeJob.amount}`);
          bot.chat(`/pay ${activeJob.player} ${activeJob.amount}`);
        }
      }
    } catch (error) {
      console.error("Backend poll failed:", error.message);
      if (error.message.includes("401")) {
        await sendStatus("failed", "Admin session expired. Close and reopen the desktop app, then sign in again.");
        await shutdown("Admin session expired");
      }
    } finally { pollInProgress = false; }
  };
  startBot();
  pollTimer = setInterval(() => { void poll(); }, 2000);
  heartbeatTimer = setInterval(() => {
    if (!stopped) void api("/api/admin/desktop-bot/heartbeat", { method: "POST", body: "{}" }).catch(error => console.error("Desktop bot heartbeat failed:", error.message));
  }, 15000);

  const shutdown = async signal => {
    if (stopped) return;
    stopped = true;
    clearInterval(pollTimer); clearInterval(heartbeatTimer); clearTimeout(reconnectTimer);
    if (activeJob) await finishJob("uncertain", "Desktop bot app closed after dispatch. Verify in game before retrying.");
    await sendStatus("disconnected", "Desktop bot app was closed.");
    try { bot?.quit(signal || "Desktop app closed"); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown("App closed"); });
  process.once("SIGTERM", () => { void shutdown("App closed"); });
}

main().catch(error => {
  console.error("\nDesktop bot could not start:", error.message);
  console.error("Press Enter to close.");
  input.resume();
  input.once("data", () => process.exit(1));
});
