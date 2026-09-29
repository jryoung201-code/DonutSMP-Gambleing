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
// A job left dispatching after a restart may already have reached the server. Never resend it automatically.
await pool.query("UPDATE bot_payment_jobs SET status='uncertain', completed_at=NOW(), result_message='Worker restarted after dispatch; verify in game before taking action.' WHERE status='dispatching'");

function messageText(message) {
  return (typeof message === "string" ? message : message?.toString?.() || "").replace(/§[0-9a-fk-or]/gi, "").toLowerCase();
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
    schedulePoll();
  });
  client.on("message", inspectServerMessage);
  client.on("kicked", reason => {
    if (activeJob) finishJob("uncertain", "Disconnected while awaiting payment confirmation: " + messageText(reason));
    console.warn("Minecraft bot was kicked:", messageText(reason));
  });
  client.on("error", error => console.error("Minecraft connection error:", error.message));
  client.on("end", () => {
    if (activeJob) finishJob("uncertain", "Minecraft disconnected after dispatch; verify in game before retrying.");
    if (!stopping) {
      console.warn("Minecraft connection ended; reconnecting in 10 seconds.");
      reconnectTimer = setTimeout(startBot, 10000);
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
  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.profileId,
      auth: "microsoft",
      version: config.version,
      profilesFolder: config.profilesFolder,
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
