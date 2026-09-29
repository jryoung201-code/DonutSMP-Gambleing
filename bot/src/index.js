import mineflayer from "mineflayer";
import pg from "pg";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const { Pool } = pg;
const required = ["DATABASE_URL", "MC_SERVER_HOST"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required environment variable: " + key);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});
const config = {
  host: process.env.MC_SERVER_HOST,
  port: Number(process.env.MC_SERVER_PORT || 25565),
  profileId: process.env.BOT_PROFILE_ID || "donutsmp-bot",
  version: process.env.MC_VERSION || false,
  profilesFolder: process.env.BOT_AUTH_CACHE_DIR || path.join(os.homedir(), ".minecraft-auth"),
  pollMs: Math.max(1000, Number(process.env.BOT_PAYMENT_POLL_MS || 2000)),
  replyTimeoutMs: Math.max(5000, Number(process.env.BOT_PAYMENT_REPLY_TIMEOUT_MS || 20000))
};

let bot;
let activeJob = null;
let pollTimer;
let reconnectTimer;
let stopping = false;
let polling = false;

await fs.mkdir(config.profilesFolder, { recursive: true });
await pool.query("CREATE TABLE IF NOT EXISTS bot_payment_jobs(job_id UUID PRIMARY KEY, request_id UUID NOT NULL UNIQUE, player TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0), status TEXT NOT NULL CHECK (status IN ('queued','dispatching','paid','rejected','uncertain')), requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, result_message TEXT)");
await pool.query("CREATE TABLE IF NOT EXISTS bot_identity(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), minecraft_uuid TEXT NOT NULL, username TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
await pool.query("CREATE TABLE IF NOT EXISTS bot_auth_status(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), state TEXT NOT NULL, user_code TEXT, verification_uri TEXT, message TEXT, username TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ)");
await pool.query("INSERT INTO bot_auth_status(singleton,state,message) VALUES(TRUE,'starting','Bot worker is starting.') ON CONFLICT(singleton) DO UPDATE SET state='starting', user_code=NULL, verification_uri=NULL, message='Bot worker is starting.', username=NULL, updated_at=NOW(), expires_at=NULL");
// A job left dispatching after a restart may already have reached the server. Never resend it automatically.
await pool.query("UPDATE bot_payment_jobs SET status='uncertain', completed_at=NOW(), result_message='Worker restarted after dispatch; verify in game before taking action.' WHERE status='dispatching'");

async function writeAuthStatus(state, { userCode = null, verificationUri = null, message = null, username = null, expiresIn = null } = {}) {
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;
  try {
    await pool.query("INSERT INTO bot_auth_status(singleton,state,user_code,verification_uri,message,username,updated_at,expires_at) VALUES(TRUE,$1,$2,$3,$4,$5,NOW(),$6) ON CONFLICT(singleton) DO UPDATE SET state=EXCLUDED.state,user_code=EXCLUDED.user_code,verification_uri=EXCLUDED.verification_uri,message=EXCLUDED.message,username=EXCLUDED.username,updated_at=NOW(),expires_at=EXCLUDED.expires_at", [state,userCode,verificationUri,message,username,expiresAt]);
  } catch (error) { console.error("Could not update bot sign-in status:", error.message); }
}
let authFailed = false;
let reconnectAttempts = 0;

function messageText(message) {
  if (message == null) return "";
  let text = "";
  if (typeof message === "string") {
    text = message;
    try { message = JSON.parse(message); } catch { return text.replace(/§[0-9a-fk-or]/gi, "").toLowerCase(); }
  } else {
    const rendered = message.toString?.();
    if (rendered && rendered !== "[object Object]") text = rendered;
  }
  if (!text) {
    const parts = [];
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (typeof value.text === "string") parts.push(value.text);
      if (typeof value.translate === "string") parts.push(value.translate);
      for (const key of ["with", "extra", "contents"]) if (value[key]) visit(value[key]);
    };
    visit(message);
    text = parts.length ? parts.join(" ") : JSON.stringify(message);
  }
  return text.replace(/§[0-9a-fk-or]/gi, "").toLowerCase();
}
function finishJob(status, message) {
  if (!activeJob) return;
  const job = activeJob;
  activeJob = null;
  clearTimeout(job.timeout);
  pool.query(
    "UPDATE bot_payment_jobs SET status=$2, completed_at=NOW(), result_message=$3 WHERE job_id=$1 AND status='dispatching'",
    [job.jobId, status, String(message).slice(0, 500)]
  ).catch(error => console.error("Could not record bot payment result:", error.message));
  console.log("Payment job", job.jobId, status + ":", message);
}
function inspectServerMessage(jsonMessage) {
  if (!activeJob) return;
  const text = messageText(jsonMessage);
  if (/don't have enough funds|do not have enough funds|not enough funds|insufficient funds|not enough money/.test(text)) {
    return finishJob("rejected", text);
  }
  const player = activeJob.player.toLowerCase();
  if ((text.includes("paid") || text.includes("payment sent") || text.includes("you sent")) && text.includes(player)) {
    return finishJob("paid", text);
  }
  if ((text.includes("cannot pay") || text.includes("can't pay") || text.includes("invalid player") || text.includes("player not found")) && text.includes(player)) {
    return finishJob("rejected", text);
  }
}
function attachBotEvents(client) {
  client.on("spawn", async () => {
    reconnectAttempts = 0;
    console.log("Minecraft bot connected as", client.username);
    const uuid = client.player?.uuid;
    if (!uuid) {
      console.error("Minecraft server did not expose the bot UUID; admin sign-in will remain unavailable.");
      return;
    }
    try {
      await pool.query(
        "INSERT INTO bot_identity(singleton,minecraft_uuid,username,updated_at) VALUES(TRUE,$1,$2,NOW()) ON CONFLICT(singleton) DO UPDATE SET minecraft_uuid=EXCLUDED.minecraft_uuid, username=EXCLUDED.username, updated_at=NOW()",
        [uuid, client.username]
      );
    } catch (error) {
      console.error("Could not save Minecraft bot identity:", error.message);
    }
    void writeAuthStatus("connected", { username: client.username, message: "The Minecraft bot is connected." });
    schedulePoll();
  });
  client.on("message", inspectServerMessage);
  client.on("kicked", reason => {
    const details = messageText(reason);
    if (activeJob) finishJob("uncertain", "Disconnected while awaiting payment confirmation: " + details);
    console.warn("Minecraft bot was kicked; server reason:", details);
    void writeAuthStatus("disconnected", { message: "The server kicked the bot: " + details.slice(0, 300) });
  });
  client.on("error", error => { console.error("Minecraft connection error:", error.message); if (!client.player) { authFailed = true; void writeAuthStatus("failed", { message: "Minecraft sign-in or connection failed. Check Render worker logs, then restart the worker to request a new code." }); } });
  client.on("end", () => {
    if (activeJob) finishJob("uncertain", "Minecraft disconnected after dispatch; verify in game before retrying.");
    if (!stopping) {
      if (!authFailed) void writeAuthStatus("disconnected", { message: "The bot disconnected and is trying to reconnect." });
      const delay = Math.min(10000 * (2 ** reconnectAttempts), 120000);
      reconnectAttempts++;
      console.warn("Minecraft connection ended; reconnecting in", Math.round(delay / 1000), "seconds.");
      reconnectTimer = setTimeout(startBot, delay);
    }
  });
}
function schedulePoll(delay = config.pollMs) {
  if (stopping || pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = undefined;
    await dispatchNext();
    if (!stopping && bot?.player) schedulePoll();
  }, delay);
}
async function claimNext() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT job_id, player, amount FROM bot_payment_jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!found.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const row = found.rows[0];
    await client.query("UPDATE bot_payment_jobs SET status='dispatching', result_message=NULL WHERE job_id=$1", [row.job_id]);
    await client.query("COMMIT");
    return { jobId: row.job_id, player: row.player, amount: BigInt(row.amount) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function dispatchNext() {
  if (polling || stopping || !bot?.player || activeJob) return;
  polling = true;
  try {
    const job = await claimNext();
    if (!job) return;
    activeJob = job;
    job.timeout = setTimeout(() => finishJob("uncertain", "No clear server response. Verify in game before any retry."), config.replyTimeoutMs);
    console.log("Sending one admin-requested /pay command for job", job.jobId);
    bot.chat("/pay " + job.player + " " + job.amount.toString());
  } catch (error) {
    console.error("Payment queue poll failed:", error.message);
  } finally {
    polling = false;
  }
}
function startBot() {
  if (stopping) return;
  authFailed = false;
  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.profileId,
      auth: "microsoft",
      version: config.version,
      profilesFolder: config.profilesFolder,
      onMsaCode: code => {
        const userCode = code?.user_code || code?.userCode || null;
        const verificationUri = code?.verification_uri || code?.verificationUri || "https://www.microsoft.com/link";
        const message = typeof code?.message === "string" ? code.message : "Open Microsoft device sign-in and enter the code shown on the admin page.";
        console.log(message);
        if (userCode) console.log("Microsoft device code:", userCode);
        void writeAuthStatus("awaiting_code", { userCode, verificationUri, message, expiresIn: Number(code?.expires_in || code?.expiresIn) || 900 });
      },
      hideErrors: false
    });
    attachBotEvents(bot);
  } catch (error) {
    console.error("Could not start Minecraft bot:", error.message);
    if (!stopping) reconnectTimer = setTimeout(startBot, 10000);
  }
}
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(signal, "received; shutting down.");
  clearTimeout(pollTimer);
  clearTimeout(reconnectTimer);
  if (activeJob) finishJob("uncertain", "Worker is shutting down after dispatch; verify in game before any retry.");
  try { bot?.quit("Worker shutting down"); } catch {}
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
startBot();
