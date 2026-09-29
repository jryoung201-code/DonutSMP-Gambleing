import express from "express";
import crypto from "node:crypto";
import pg from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOT_DIR = path.join(REPO_ROOT, "bot");
let botProcess = null;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
}) : null;

let CONFIG = {
  minimumBet: 100000n,
  maximumBet: 2000000n,
  paymentTarget: process.env.PAYMENT_TARGET || "VoduDoll_YT",
  enabledGames: ["50_50", "wheel", "crates", "horseRacing", "45_45_10", "oddEven"],
  showOdds: process.env.SHOW_ODDS === "true",
  fiftyFiftyWinPercent: 50,
  oddsBasisPoints: { "50_50": { WIN: 4000, LOSE: 6000 } },
  cratePrices: { basic: 20000n, rare: 200000n, legendary: 30000000n },
  // Server-side payout configuration. 10000 basis points = 1x.
  multipliers: {
    "50_50": { WIN: 20000, LOSE: 0 },
    "45_45_10": { WIN: 20000, LOSE: 0, JACKPOT: 50000 },
    oddEven: { WIN: 20000, LOSE: 0 },
    horseRacing: { WIN: 30000, LOSE: 0 }
  }
};

const sessions = new Map();
const adminSessions = new Map();
const adminLoginAttempts = new Map();
let memoryAdminConfig = null;
const memoryTransactions = new Map();
const memoryPaymentTransactions = new Map();
const memoryBalances = new Map();
const ADMIN_MAX_FORCE_PAY = BigInt(Number.isSafeInteger(Number(process.env.ADMIN_MAX_FORCE_PAY)) && Number(process.env.ADMIN_MAX_FORCE_PAY) > 0 ? Number(process.env.ADMIN_MAX_FORCE_PAY) : 5000000);
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 5;
const rateHistory = new Map();

const crateRows = {
  basic: [
    ["coal","Coal (Stack)","minecraft:coal",64,6000,"common"],
    ["iron_ingot","Iron Ingot","minecraft:iron_ingot",1,250,"common"],
    ["ender_pearl","Ender Pearl (Stack)","minecraft:ender_pearl",16,2500,"common"],
    ["diamond","Diamond","minecraft:diamond",1,2500,"uncommon"],
    ["emerald_block","Emerald Block","minecraft:emerald_block",1,4500,"rare"],
    ["netherite_scrap","Netherite Scrap","minecraft:netherite_scrap",1,1000000,"jackpot"]
  ],
  rare: [
    ["gold_block","Gold Block","minecraft:gold_block",1,20000,"common"],
    ["diamond_block","Diamond Block","minecraft:diamond_block",1,22500,"common"],
    ["emerald_block_stack","Emerald Block (Stack)","minecraft:emerald_block",64,300000,"rare"],
    ["ancient_debris","Ancient Debris","minecraft:ancient_debris",1,1000000,"epic"],
    ["netherite_ingot","Netherite Ingot","minecraft:netherite_ingot",1,4500000,"jackpot"],
    ["shulker_shell_stack","Shulker Shell (Stack)","minecraft:shulker_shell",64,51200,"uncommon"]
  ],
  legendary: [
    ["netherite_ingot_stack","Netherite Ingot (Stack)","minecraft:netherite_ingot",64,300000000,"jackpot"],
    ["netherite_block","Netherite Block","minecraft:netherite_block",1,40000000,"epic"],
    ["elytra","Elytra","minecraft:elytra",1,320000000,"jackpot"],
    ["totem","Totem of Undying","minecraft:totem_of_undying",1,15000,"common"],
    ["golden_apple_stack","Golden Apple (Stack)","minecraft:golden_apple",64,64000,"uncommon"],
    ["enchanted_golden_apple","Enchanted Golden Apple","minecraft:enchanted_golden_apple",1,500000,"rare"],
    ["dragon_head","Dragon Head","minecraft:dragon_head",1,56900000,"epic"]
  ]
};
const crateWeights = {
  basic: [5000,3000,1400,500,99,1],
  rare: [4200,3000,1300,800,20,680],
  legendary: [5000,1500,900,300,150,80,2]
};

function uuidV4(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? Number(v) : v));
}
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  while (true) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < limit) return n % max;
  }
}
function weightedIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = randomInt(total);
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}
function payoutFromBasisPoints(bet, basisPoints) {
  // Defined rounding rule: floor toward zero for positive integer currency.
  return bet * BigInt(basisPoints) / 10000n;
}
function validMultiplier(bp) {
  return Number.isInteger(bp) && bp >= 0 && bp <= 999999;
}
function multiplierText(bp) {
  if (!validMultiplier(bp)) return null;
  if (bp === 0) return "0x";
  const whole = Math.floor(bp / 10000);
  const hundredths = Math.floor((bp % 10000) / 100);
  if (hundredths === 0) return whole + "x";
  if (hundredths % 10 === 0) return whole + "." + (hundredths / 10) + "x";
  return whole + "." + String(hundredths).padStart(2, "0") + "x";
}
function legalSelection(game, selection) {
  const legal = {
    oddEven: ["odd", "even"],
    horseRacing: ["diamond", "iron", "gold"],
    crates: ["basic", "rare", "legendary"]
  };
  return !legal[game] || legal[game].includes(selection);
}
function rateLimited(uuid) {
  const now = Date.now();
  const arr = (rateHistory.get(uuid) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    rateHistory.set(uuid, arr);
    return true;
  }
  arr.push(now);
  rateHistory.set(uuid, arr);
  return false;
}
function sessionFor(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const session = sessions.get(auth.slice(7));
  return session && session.expiresAt > Date.now() ? session : null;
}
function reject(res, transactionId, code, reason, status = 400) {
  return res.status(status).json({ accepted: false, transactionId, code, reason });
}
function adminConfigValues() {
  return {
    minimumBet: Number(CONFIG.minimumBet),
    maximumBet: Number(CONFIG.maximumBet),
    paymentTarget: CONFIG.paymentTarget,
    showOdds: CONFIG.showOdds,
    enabledGames: CONFIG.enabledGames,
    fiftyFiftyWinPercent: CONFIG.fiftyFiftyWinPercent
  };
}
function applyAdminConfig(value) {
  CONFIG = {
    ...CONFIG,
    minimumBet: BigInt(value.minimumBet),
    maximumBet: BigInt(value.maximumBet),
    paymentTarget: value.paymentTarget,
    showOdds: value.showOdds,
    enabledGames: value.enabledGames,
    fiftyFiftyWinPercent: value.fiftyFiftyWinPercent,
    oddsBasisPoints: { "50_50": { WIN: value.fiftyFiftyWinPercent * 100, LOSE: (100 - value.fiftyFiftyWinPercent) * 100 } }
  };
}
async function loadAdminConfig() {
  if (!pool) {
    memoryAdminConfig ??= adminConfigValues();
    applyAdminConfig(memoryAdminConfig);
    return;
  }
  await pool.query("CREATE TABLE IF NOT EXISTS admin_config(id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id IS TRUE), minimum_bet BIGINT NOT NULL, maximum_bet BIGINT NOT NULL, payment_target TEXT NOT NULL, show_odds BOOLEAN NOT NULL DEFAULT FALSE, enabled_games JSONB NOT NULL, fifty_fifty_win_percent INTEGER NOT NULL DEFAULT 50)");
  await pool.query("ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS fifty_fifty_win_percent INTEGER NOT NULL DEFAULT 50");
  const defaults = adminConfigValues();
  await pool.query(
    "INSERT INTO admin_config(id, minimum_bet, maximum_bet, payment_target, show_odds, enabled_games, fifty_fifty_win_percent) VALUES(TRUE, $1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT(id) DO NOTHING",
    [String(defaults.minimumBet), String(defaults.maximumBet), defaults.paymentTarget, defaults.showOdds, JSON.stringify(defaults.enabledGames), defaults.fiftyFiftyWinPercent]
  );
  const result = await pool.query("SELECT minimum_bet, maximum_bet, payment_target, show_odds, enabled_games, fifty_fifty_win_percent FROM admin_config WHERE id=TRUE");
  const row = result.rows[0];
  applyAdminConfig({
    minimumBet: Number(row.minimum_bet),
    maximumBet: Number(row.maximum_bet),
    paymentTarget: row.payment_target,
    showOdds: row.show_odds,
    enabledGames: row.enabled_games,
    fiftyFiftyWinPercent: row.fifty_fifty_win_percent
  });
}
async function ensureSchema() {
  if (pool) {
    await pool.query("CREATE TABLE IF NOT EXISTS players(uuid TEXT PRIMARY KEY, username TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0)");
    await pool.query("CREATE TABLE IF NOT EXISTS transactions(player_uuid TEXT NOT NULL, transaction_id UUID NOT NULL, request JSONB NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(player_uuid, transaction_id))");
    await pool.query("CREATE TABLE IF NOT EXISTS payment_transactions(transaction_id UUID PRIMARY KEY, player_uuid TEXT NOT NULL, username TEXT NOT NULL, target TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0), status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','paid')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await pool.query("ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'recorded'");
    await pool.query("CREATE TABLE IF NOT EXISTS bot_payment_jobs(job_id UUID PRIMARY KEY, request_id UUID NOT NULL UNIQUE, player TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0), status TEXT NOT NULL CHECK (status IN ('queued','dispatching','paid','rejected','uncertain')), requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, result_message TEXT)");
    await pool.query("CREATE TABLE IF NOT EXISTS bot_identity(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), minecraft_uuid TEXT NOT NULL, username TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await pool.query("CREATE TABLE IF NOT EXISTS bot_auth_status(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), state TEXT NOT NULL, user_code TEXT, verification_uri TEXT, message TEXT, username TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ)");
    await pool.query("CREATE TABLE IF NOT EXISTS desktop_bot_control(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), restart_requested BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await pool.query("INSERT INTO desktop_bot_control(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING");
    await pool.query("CREATE TABLE IF NOT EXISTS desktop_bot_presence(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE), state TEXT NOT NULL, username TEXT, message TEXT, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  }
  await loadAdminConfig();
}
async function balanceFor(uuid) {
  if (!pool) return memoryBalances.get(uuid) ?? 0n;
  const row = await pool.query("SELECT balance FROM players WHERE uuid=$1", [uuid]);
  return row.rowCount ? BigInt(row.rows[0].balance) : 0n;
}

function makeWheelLayout() {
  const counts = { "0x": 9, "0.5x": 6, "1x": 4, "1.5x": 3, "2x": 2, "3x": 1 };
  for (let attempt = 0; attempt < 1000; attempt++) {
    const layout = [];
    for (const [value, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i++) layout.push(value);
    }
    for (let i = layout.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [layout[i], layout[j]] = [layout[j], layout[i]];
    }
    let run = 1, valid = true;
    for (let i = 1; i < layout.length; i++) {
      run = layout[i] === layout[i - 1] ? run + 1 : 1;
      if (run > 2) { valid = false; break; }
    }
    if (valid) return layout;
  }
  throw new Error("Unable to create valid wheel layout");
}

function makeCrateReel(crate, rewardId) {
  const rows = crateRows[crate];
  const ids = rows.map(row => row[0]);
  const reel = Array.from({ length: 70 }, () => ids[weightedIndex(crateWeights[crate])]);
  const slot = 8 + randomInt(54);
  reel[slot] = rewardId;
  return { reel, slot };
}

async function authenticate(req, res) {
  const { username, serverId } = req.body || {};
  if (typeof username !== "string" || !username || typeof serverId !== "string") {
    return reject(res, null, "UNAUTHENTICATED", "Username and serverId are required", 401);
  }
  const challenge = sessions.get("challenge:" + serverId);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    return reject(res, null, "UNAUTHENTICATED", "Challenge expired or invalid", 401);
  }

  try {
    const url = "https://sessionserver.mojang.com/session/minecraft/hasJoined?username=" +
      encodeURIComponent(username) + "&serverId=" + encodeURIComponent(serverId);
    const response = await fetch(url);
    if (!response.ok) {
      return reject(res, null, "UNAUTHENTICATED", "Mojang session verification failed", 401);
    }
    const profile = await response.json();
    if (!profile.id) {
      return reject(res, null, "UNAUTHENTICATED", "Mojang did not verify this session", 401);
    }

    const verifiedUuid = profile.id.replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
      "$1-$2-$3-$4-$5"
    );
    if (!uuidV4(verifiedUuid)) {
      return reject(res, null, "UNAUTHENTICATED", "Invalid verified UUID", 401);
    }

    sessions.delete("challenge:" + serverId);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, {
      playerUuid: verifiedUuid,
      username: profile.name || username,
      expiresAt: Date.now() + 900000
    });
    return res.json({ token, expiresInSeconds: 900 });
  } catch (error) {
    console.error(error);
    return reject(res, null, "UNAUTHENTICATED", "Mojang verification unavailable", 401);
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/auth/challenge", (req, res) => {
  const serverId = crypto.randomBytes(24).toString("base64url");
  sessions.set("challenge:" + serverId, { expiresAt: Date.now() + 60000 });
  res.json({ serverId });
});

app.post("/api/auth/login", authenticate);

app.get("/api/config", (req, res) => {
  const response = {
    minimumBet: Number(CONFIG.minimumBet),
    maximumBet: Number(CONFIG.maximumBet),
    paymentTarget: CONFIG.paymentTarget,
    enabledGames: CONFIG.enabledGames,
    showOdds: CONFIG.showOdds,
    oddsBasisPoints: { "50_50": { WIN: CONFIG.fiftyFiftyWinPercent * 100, LOSE: (100 - CONFIG.fiftyFiftyWinPercent) * 100 } },
    cratePrices: Object.fromEntries(Object.entries(CONFIG.cratePrices).map(([k, v]) => [k, Number(v)]))
  };
  if (CONFIG.showOdds) response.oddsBasisPoints = { "50_50": { WIN: CONFIG.fiftyFiftyWinPercent * 100, LOSE: (100 - CONFIG.fiftyFiftyWinPercent) * 100 } };
  res.json(response);
});

const ADMIN_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>DonutSMP Admin</title><style>\n*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0d0d12;color:#fff;font:16px Arial,sans-serif;display:grid;place-items:center;padding:20px}\nmain{width:min(720px,100%);background:#17171f;border:1px solid #363644;border-radius:16px;padding:24px;box-shadow:0 18px 55px #0008}\nh1{margin:0 0 8px}p{color:#aaaab8;margin:0 0 18px}label{display:block;color:#aaaab8;font-size:13px;font-weight:bold;margin:12px 0}\n.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}input{display:block;width:100%;margin-top:6px;padding:11px;border:1px solid #363644;border-radius:8px;background:#101017;color:white;font-size:16px}\nbutton{border:0;border-radius:9px;padding:12px 16px;color:white;background:#5865f2;font-weight:bold;font-size:15px;cursor:pointer;margin-top:10px}button.secondary{background:#30303a;margin-left:8px}\n.games{display:grid;grid-template-columns:1fr 1fr;gap:8px}.games label{margin:3px 0;color:#eee}.games input{display:inline-block;width:auto;margin:0 8px 0 0}\n.notice{min-height:24px;margin-top:12px;color:#aaaab8}.error{color:#f87171}.success{color:#4ade80}.job{padding:10px;margin:8px 0;background:#20202a;border-radius:8px;overflow-wrap:anywhere}[hidden]{display:none!important}\n@media(max-width:480px){.row{grid-template-columns:1fr}}\n</style></head><body><main>\n<h1>DonutSMP Admin</h1><p>Sign in with your admin password.</p>\n<section id=\"login\"><form id=\"passwordLogin\"><label>Admin password<input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" required></label><button type=\"submit\">Sign in</button></form></section>\n<section id=\"admin\" hidden>\n<h2>Link Minecraft bot account</h2><p>Run the DonutSMP Desktop Bot app on your PC. When it displays a code, open <a id=\"verifyLink\" href=\"https://www.microsoft.com/link\" target=\"_blank\" rel=\"noopener noreferrer\">Microsoft device sign-in</a> and enter it. The code is visible only after admin sign-in.</p><div id=\"device\" class=\"job\" aria-live=\"polite\"><strong id=\"deviceState\">Checking bot status…</strong><p id=\"deviceMessage\">Waiting for the desktop app on your PC.</p><p id=\"userCode\" style=\"font-size:28px;font-weight:bold;letter-spacing:3px\"></p></div><button type=\"button\" id=\"restartBot\">Restart Bot / Rejoin</button><h2>Server configuration</h2><form id=\"settings\">\n<div class=\"row\"><label>Minimum amount<input id=\"minimumBet\" inputmode=\"numeric\" type=\"number\" min=\"1\" required></label><label>Maximum amount<input id=\"maximumBet\" inputmode=\"numeric\" type=\"number\" min=\"1\" required></label></div>\n<label>Payment target<input id=\"paymentTarget\" maxlength=\"16\" required></label>\n<label>50/50 win chance (%)<input id=\"fiftyFiftyWinPercent\" inputmode=\"numeric\" type=\"number\" min=\"0\" max=\"100\" required></label>\n<label><input id=\"showOdds\" type=\"checkbox\"> Show odds in the mod</label>\n<div><strong>Enabled games</strong><div id=\"games\" class=\"games\"></div></div>\n<button type=\"submit\">Save configuration</button></form>\n<h2>Force bot payment</h2><p>Queues one Minecraft <code>/pay &lt;player&gt; &lt;amount&gt;</code> command. Max per payment: <span id=\"forcePayMax\"></span>. Confirm each send.</p>\n<form id=\"forcePay\"><div class=\"row\"><label>Player<input id=\"payPlayer\" maxlength=\"16\" required></label><label>Amount<input id=\"payAmount\" inputmode=\"numeric\" type=\"number\" min=\"1\" required></label></div><button id=\"payButton\" type=\"submit\">Queue payment</button></form>\n<div id=\"jobs\"></div><button class=\"secondary\" id=\"logout\" type=\"button\">Sign out</button>\n</section><div id=\"notice\" class=\"notice\"></div>\n<script>\nconst ids=[\"50_50\",\"wheel\",\"crates\",\"horseRacing\",\"45_45_10\",\"oddEven\"];\nconst labels={\"50_50\":\"50/50\",wheel:\"Wheel\",crates:\"Crates\",horseRacing:\"Horse Racing\",\"45_45_10\":\"45/45/10\",oddEven:\"Odd or Even\"};\nconst login=document.getElementById(\"login\"),admin=document.getElementById(\"admin\"),notice=document.getElementById(\"notice\");\nfor(const id of ids){const label=document.createElement(\"label\");const input=document.createElement(\"input\");input.type=\"checkbox\";input.name=\"enabledGames\";input.value=id;label.append(input,document.createTextNode(labels[id]));document.getElementById(\"games\").append(label);}\nfunction say(text,kind){notice.textContent=text;notice.className=\"notice \"+(kind||\"\");}\nasync function api(path,options){const response=await fetch(path,Object.assign({credentials:\"same-origin\",headers:{\"Content-Type\":\"application/json\"}},options||{}));const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.reason||\"Request failed (\"+response.status+\")\");return data;}\nasync function load(){const value=await api(\"/api/admin/config\");document.getElementById(\"minimumBet\").value=value.minimumBet;document.getElementById(\"maximumBet\").value=value.maximumBet;document.getElementById(\"paymentTarget\").value=value.paymentTarget;document.getElementById(\"fiftyFiftyWinPercent\").value=value.fiftyFiftyWinPercent;document.getElementById(\"showOdds\").checked=value.showOdds;document.querySelectorAll(\"[name=enabledGames]\").forEach(box=>box.checked=value.enabledGames.includes(box.value));document.getElementById(\"forcePayMax\").textContent=Number(value.maximumForcePay).toLocaleString();login.hidden=true;admin.hidden=false;await loadJobs();await loadDevice();}\nasync function loadJobs(){try{const data=await api(\"/api/admin/bot-payments\");const container=document.getElementById(\"jobs\");container.replaceChildren();if(!data.jobs.length){container.textContent=\"No bot payments yet.\";return;}for(const job of data.jobs){const card=document.createElement(\"div\");card.className=\"job\";const title=document.createElement(\"strong\");title.textContent=job.status.toUpperCase();card.append(title,document.createTextNode(\" — \"+job.player+\" · \"+Number(job.amount).toLocaleString()+\" · \"+new Date(job.createdAt).toLocaleString()));if(job.resultMessage){card.append(document.createElement(\"br\"),document.createTextNode(job.resultMessage));}container.append(card);}}catch(error){say(error.message,\"error\");}}\nasync function loadDevice(){try{const info=await api(\"/api/admin/bot-auth\");document.getElementById(\"deviceState\").textContent=info.stateLabel;document.getElementById(\"deviceMessage\").textContent=info.message||\"\";document.getElementById(\"userCode\").textContent=info.userCode||\"\";document.getElementById(\"verifyLink\").href=info.verificationUri||\"https://www.microsoft.com/link\";}catch(error){if(error.message.includes(\"401\")){admin.hidden=true;login.hidden=false;}else document.getElementById(\"deviceMessage\").textContent=error.message;}}\ndocument.getElementById(\"restartBot\").addEventListener(\"click\",async()=>{const button=document.getElementById(\"restartBot\");button.disabled=true;say(\"Restart request sent to the desktop app. It must be running on your PC.\");try{await api(\"/api/admin/bot/restart\",{method:\"POST\"});say(\"Restart request sent. Check the sign-in status above.\",\"success\");await loadDevice();}catch(error){say(error.message,\"error\");}finally{button.disabled=false;}});document.getElementById(\"passwordLogin\").addEventListener(\"submit\",async event=>{event.preventDefault();const input=document.getElementById(\"adminPassword\");try{await api(\"/api/admin/password-login\",{method:\"POST\",body:JSON.stringify({password:input.value})});input.value=\"\";await load();say(\"Signed in.\",\"success\");}catch(error){say(error.message,\"error\");}});\ndocument.getElementById(\"settings\").addEventListener(\"submit\",async event=>{event.preventDefault();const body={minimumBet:Number(document.getElementById(\"minimumBet\").value),maximumBet:Number(document.getElementById(\"maximumBet\").value),paymentTarget:document.getElementById(\"paymentTarget\").value.trim(),showOdds:document.getElementById(\"showOdds\").checked,fiftyFiftyWinPercent:Number(document.getElementById(\"fiftyFiftyWinPercent\").value),enabledGames:Array.from(document.querySelectorAll(\"[name=enabledGames]:checked\"),box=>box.value)};try{await api(\"/api/admin/config\",{method:\"PUT\",body:JSON.stringify(body)});say(\"Configuration saved.\",\"success\");}catch(error){say(error.message,\"error\");}});\ndocument.getElementById(\"forcePay\").addEventListener(\"submit\",async event=>{event.preventDefault();const player=document.getElementById(\"payPlayer\").value.trim(),amount=Number(document.getElementById(\"payAmount\").value);if(!confirm(\"Send \"+amount.toLocaleString()+\" coins from the bot to \"+player+\"? This action cannot be undone.\"))return;const button=document.getElementById(\"payButton\");button.disabled=true;try{const job=await api(\"/api/admin/bot-payments\",{method:\"POST\",body:JSON.stringify({player,amount,requestId:crypto.randomUUID()})});say(\"Payment queued as \"+job.jobId+\".\",\"success\");document.getElementById(\"payPlayer\").value=\"\";document.getElementById(\"payAmount\").value=\"\";await loadJobs();}catch(error){say(error.message,\"error\");}finally{button.disabled=false;}});\ndocument.getElementById(\"logout\").addEventListener(\"click\",async()=>{try{await api(\"/api/admin/logout\",{method:\"POST\"});}finally{admin.hidden=true;login.hidden=false;document.getElementById(\"passwordLogin\").hidden=false;say(\"Signed out.\");}});\napi(\"/api/admin/config\").then(load).catch(()=>{});\nsetInterval(()=>{if(!admin.hidden){loadJobs();loadDevice();}},3000);\n</script></main></body></html>";
function adminSession(req) {
  const match = (req.headers.cookie || "").match(/(?:^|;\s*)gamehub_admin=([^;]+)/);
  if (!match) return null;
  const session = adminSessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    adminSessions.delete(match[1]);
    return null;
  }
  return session;
}
function requireAdmin(req, res, next) {
  if (!adminSession(req)) return res.status(401).json({ authenticated: false, reason: "Unauthorized" });
  next();
}
function sameAdminOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === req.get("host"); }
  catch { return false; }
}
app.get("/admin", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; navigate-to https://www.microsoft.com; base-uri 'none'; frame-ancestors 'none'");
  return res.type("html").send(ADMIN_PAGE);
});
app.post("/api/admin/password-login", (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 12) return res.status(503).json({ reason: "Admin password is not configured (set ADMIN_PASSWORD to at least 12 characters)" });
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const prior = (adminLoginAttempts.get("password:" + key) || []).filter(time => now - time < 600000);
  if (prior.length >= 5) return res.status(429).json({ reason: "Too many sign-in attempts; wait before trying again" });
  prior.push(now);
  adminLoginAttempts.set("password:" + key, prior);
  const supplied = req.body?.password;
  if (typeof supplied !== "string" || supplied.length > 256) return res.status(401).json({ reason: "Incorrect admin password" });
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
  if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) return res.status(401).json({ reason: "Incorrect admin password" });
  const token = crypto.randomBytes(32).toString("base64url");
  adminSessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000, username: "admin" });
  res.set("Cache-Control", "no-store");
  res.set("Set-Cookie", "gamehub_admin=" + token + "; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800");
  return res.json({ authenticated: true, expiresInSeconds: 28800 });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  const match = (req.headers.cookie || "").match(/(?:^|;\s*)gamehub_admin=([^;]+)/);
  if (match) adminSessions.delete(match[1]);
  res.set("Set-Cookie", "gamehub_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  return res.json({ authenticated: false });
});
app.get("/api/admin/config", requireAdmin, (req, res) => res.set("Cache-Control", "no-store").json({ ...adminConfigValues(), maximumForcePay: Number(ADMIN_MAX_FORCE_PAY) }));
app.put("/api/admin/config", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  const { minimumBet, maximumBet, paymentTarget, showOdds, enabledGames, fiftyFiftyWinPercent } = req.body || {};
  const validName = typeof paymentTarget === "string" && /^\.?[A-Za-z0-9_]{3,16}$/.test(paymentTarget);
  if (!Number.isSafeInteger(minimumBet) || minimumBet < 1 ||
      !Number.isSafeInteger(maximumBet) || maximumBet < minimumBet ||
      !Number.isInteger(fiftyFiftyWinPercent) || fiftyFiftyWinPercent < 0 || fiftyFiftyWinPercent > 100 ||
      !validName || typeof showOdds !== "boolean" ||
      !Array.isArray(enabledGames) || enabledGames.some(game => !["50_50", "wheel", "crates", "horseRacing", "45_45_10", "oddEven"].includes(game)) ||
      new Set(enabledGames).size !== enabledGames.length) {
    return res.status(400).json({ reason: "Check the amount limits, Minecraft username, and enabled games" });
  }
  const next = { minimumBet, maximumBet, paymentTarget, showOdds, enabledGames, fiftyFiftyWinPercent };
  try {
    if (pool) {
      await pool.query(
        "INSERT INTO admin_config(id, minimum_bet, maximum_bet, payment_target, show_odds, enabled_games, fifty_fifty_win_percent) VALUES(TRUE, $1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT(id) DO UPDATE SET minimum_bet=EXCLUDED.minimum_bet, maximum_bet=EXCLUDED.maximum_bet, payment_target=EXCLUDED.payment_target, show_odds=EXCLUDED.show_odds, enabled_games=EXCLUDED.enabled_games, fifty_fifty_win_percent=EXCLUDED.fifty_fifty_win_percent",
        [String(minimumBet), String(maximumBet), paymentTarget, showOdds, JSON.stringify(enabledGames), fiftyFiftyWinPercent]
      );
    } else {
      memoryAdminConfig = next;
    }
    applyAdminConfig(next);
    return res.json({ saved: true, ...adminConfigValues() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ reason: "Could not save configuration" });
  }
});

app.post("/api/admin/bot-payments", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for bot payments" });
  const { player, amount, requestId } = req.body || {};
  if (typeof player !== "string" || !/^\.?[A-Za-z0-9_]{3,16}$/.test(player) ||
      !Number.isSafeInteger(amount) || amount < 1 || BigInt(amount) > ADMIN_MAX_FORCE_PAY ||
      !uuidV4(requestId)) {
    return res.status(400).json({ reason: "Enter a valid Minecraft player, positive whole amount, and request ID" });
  }
  try {
    const existing = await pool.query("SELECT job_id, player, amount, status FROM bot_payment_jobs WHERE request_id=$1", [requestId]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      return res.status(200).json({ jobId: row.job_id, player: row.player, amount: Number(row.amount), status: row.status, replayed: true });
    }
    const jobId = crypto.randomUUID();
    const session = adminSession(req);
    await pool.query(
      "INSERT INTO bot_payment_jobs(job_id, request_id, player, amount, status, requested_by) VALUES($1,$2,$3,$4,'queued',$5)",
      [jobId, requestId, player, String(amount), session.username || "minecraft-admin"]
    );
    return res.status(202).json({ jobId, player, amount, status: "queued" });
  } catch (error) {
    if (error.code === "23505") {
      const existing = await pool.query("SELECT job_id, player, amount, status FROM bot_payment_jobs WHERE request_id=$1", [requestId]);
      if (existing.rowCount) return res.status(200).json({ jobId: existing.rows[0].job_id, player: existing.rows[0].player, amount: Number(existing.rows[0].amount), status: existing.rows[0].status, replayed: true });
    }
    console.error(error);
    return res.status(500).json({ reason: "Could not queue bot payment" });
  }
});
app.get("/api/admin/bot-payments", requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for bot payments" });
  try {
    const result = await pool.query("SELECT job_id, player, amount, status, requested_by, created_at, completed_at, result_message FROM bot_payment_jobs ORDER BY created_at DESC LIMIT 20");
    return res.set("Cache-Control", "no-store").json({
      jobs: result.rows.map(row => ({
        jobId: row.job_id,
        player: row.player,
        amount: Number(row.amount),
        status: row.status,
        requestedBy: row.requested_by,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        resultMessage: row.result_message
      }))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ reason: "Could not load bot payments" });
  }
});

function launchBotProcess() {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: BOT_DIR,
    env: process.env,
    stdio: "inherit"
  });
  botProcess = child;
  child.once("error", error => {
    console.error("Could not start Minecraft bot:", error.message);
    if (botProcess === child) botProcess = null;
  });
  child.once("exit", (code, signal) => {
    console.log("On-demand Minecraft bot stopped:", code ?? signal);
    if (botProcess === child) botProcess = null;
  });
  return child;
}
let botRestarting = false;

app.post("/api/admin/bot/start", requireAdmin, (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  return res.status(409).json({ reason: "Run the DonutSMP Desktop Bot app on your PC to connect from your home internet." });
});

app.post("/api/admin/bot/restart", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for bot controls" });
  try {
    await pool.query("UPDATE desktop_bot_control SET restart_requested=TRUE, updated_at=NOW() WHERE singleton=TRUE");
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ restarting: true, message: "Restart requested. The desktop bot app must be running on your PC." });
  } catch (error) {
    console.error("Could not request desktop bot restart:", error.message);
    return res.status(500).json({ reason: "Could not request bot restart" });
  }
});

app.post("/api/admin/desktop-bot/status", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for the desktop bot" });
  const { state, message = "", username = null, userCode = null, verificationUri = null, expiresIn = null, minecraftUuid = null } = req.body || {};
  const states = ["starting", "awaiting_code", "authenticated", "connecting", "joining", "connected", "failed", "blocked", "disconnected"];
  if (!states.includes(state) || typeof message !== "string" || message.length > 500 ||
      (username !== null && (typeof username !== "string" || username.length > 16)) ||
      (userCode !== null && (typeof userCode !== "string" || userCode.length > 32)) ||
      (verificationUri !== null && (typeof verificationUri !== "string" || !/^https:\/\//.test(verificationUri))) ||
      (minecraftUuid !== null && (typeof minecraftUuid !== "string" || !/^[0-9a-f-]{32,36}$/i.test(minecraftUuid)))) {
    return res.status(400).json({ reason: "Invalid desktop bot status" });
  }
  try {
    await pool.query(
      "INSERT INTO desktop_bot_presence(singleton,state,username,message,last_seen) VALUES(TRUE,$1,$2,$3,NOW()) ON CONFLICT(singleton) DO UPDATE SET state=EXCLUDED.state,username=EXCLUDED.username,message=EXCLUDED.message,last_seen=NOW()",
      [state, username, message]
    );
    const expiry = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + Math.min(expiresIn, 1800) * 1000) : null;
    await pool.query(
      "INSERT INTO bot_auth_status(singleton,state,user_code,verification_uri,message,username,updated_at,expires_at) VALUES(TRUE,$1,$2,$3,$4,$5,NOW(),$6) ON CONFLICT(singleton) DO UPDATE SET state=EXCLUDED.state,user_code=EXCLUDED.user_code,verification_uri=EXCLUDED.verification_uri,message=EXCLUDED.message,username=EXCLUDED.username,updated_at=NOW(),expires_at=EXCLUDED.expires_at",
      [state, state === "awaiting_code" ? userCode : null, state === "awaiting_code" ? verificationUri : null, message, username, expiry]
    );
    if (minecraftUuid && username) {
      await pool.query("INSERT INTO bot_identity(singleton,minecraft_uuid,username,updated_at) VALUES(TRUE,$1,$2,NOW()) ON CONFLICT(singleton) DO UPDATE SET minecraft_uuid=EXCLUDED.minecraft_uuid,username=EXCLUDED.username,updated_at=NOW()", [minecraftUuid, username]);
    }
    return res.json({ updated: true });
  } catch (error) {
    console.error("Could not save desktop bot status:", error.message);
    return res.status(500).json({ reason: "Could not save desktop bot status" });
  }
});
app.post("/api/admin/desktop-bot/heartbeat", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for the desktop bot" });
  const result = await pool.query("UPDATE desktop_bot_presence SET last_seen=NOW() WHERE singleton=TRUE");
  if (!result.rowCount) return res.status(409).json({ reason: "Desktop bot status has not been registered yet" });
  return res.set("Cache-Control", "no-store").json({ online: true });
});

app.get("/api/admin/desktop-bot/control", requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for desktop bot controls" });
  const result = await pool.query("SELECT restart_requested FROM desktop_bot_control WHERE singleton=TRUE");
  return res.set("Cache-Control", "no-store").json({ restartRequested: Boolean(result.rows[0]?.restart_requested) });
});
app.post("/api/admin/desktop-bot/control/ack", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for desktop bot controls" });
  await pool.query("UPDATE desktop_bot_control SET restart_requested=FALSE,updated_at=NOW() WHERE singleton=TRUE");
  return res.json({ acknowledged: true });
});
app.post("/api/admin/desktop-bot/jobs/claim", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for bot payments" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT job_id,player,amount FROM bot_payment_jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!found.rowCount) { await client.query("COMMIT"); return res.json({ job: null }); }
    const row = found.rows[0];
    await client.query("UPDATE bot_payment_jobs SET status='dispatching',result_message=NULL WHERE job_id=$1", [row.job_id]);
    await client.query("COMMIT");
    return res.json({ job: { jobId: row.job_id, player: row.player, amount: String(row.amount) } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Could not claim desktop bot payment:", error.message);
    return res.status(500).json({ reason: "Could not claim a payment job" });
  } finally { client.release(); }
});
app.post("/api/admin/desktop-bot/jobs/:jobId/result", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!pool) return res.status(503).json({ reason: "Persistent database is required for bot payments" });
  if (!uuidV4(req.params.jobId)) return res.status(400).json({ reason: "Invalid job ID" });
  const { status, message = "" } = req.body || {};
  if (!["paid", "rejected", "uncertain"].includes(status) || typeof message !== "string" || message.length > 500) {
    return res.status(400).json({ reason: "Invalid payment result" });
  }
  const result = await pool.query("UPDATE bot_payment_jobs SET status=$2,result_message=$3,completed_at=NOW() WHERE job_id=$1 AND status='dispatching'", [req.params.jobId, status, message]);
  if (!result.rowCount) return res.status(409).json({ reason: "Payment job is no longer awaiting a result" });
  return res.json({ updated: true });
});

app.get("/api/admin/bot-auth", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!pool) return res.json({ state: "unavailable", stateLabel: "Status unavailable", userCode: null, verificationUri: "https://www.microsoft.com/link", message: "The database is not connected." });
  try {
    const presence = await pool.query("SELECT state,username,message,last_seen FROM desktop_bot_presence WHERE singleton=TRUE");
    if (!presence.rowCount) return res.json({ state: "not_started", stateLabel: "Desktop app not running", userCode: null, verificationUri: "https://www.microsoft.com/link", message: "Open the DonutSMP Desktop Bot app on your PC. It connects to the server using your home internet." });
    const online = Date.now() - new Date(presence.rows[0].last_seen).getTime() < 45000;
    if (!online) return res.json({ state: "disconnected", stateLabel: "Desktop app offline", userCode: null, verificationUri: "https://www.microsoft.com/link", message: "The desktop app has stopped checking in. Open it on your PC to reconnect." });
    const result = await pool.query("SELECT state,user_code,verification_uri,message,username,updated_at,expires_at FROM bot_auth_status WHERE singleton=TRUE");
    if (!result.rowCount) return res.json({ state: "starting", stateLabel: "Desktop app starting", userCode: null, verificationUri: "https://www.microsoft.com/link", message: presence.rows[0].message || "Waiting for the desktop bot app." });
    const row = result.rows[0];
    const codeValid = row.state === "awaiting_code" && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
    const stateLabel = codeValid ? "Sign in with Microsoft" : ({ starting: "Desktop bot starting", awaiting_code: "Sign in with Microsoft", authenticated: "Account linked", connecting: "Connecting to DonutSMP", joining: "DonutSMP is loading the bot", connected: "Bot connected from your PC", failed: "Bot sign-in failed", blocked: "DonutSMP security check", disconnected: "Bot disconnected" }[row.state] || "Waiting for desktop bot");
    const message = codeValid ? "Enter this code at Microsoft device sign-in. This code expires shortly." : (row.message || (row.username ? "Signed in as " + row.username + "." : "Waiting for the bot worker."));
    return res.json({ state: codeValid ? row.state : row.state === "awaiting_code" ? "expired" : row.state, stateLabel, userCode: codeValid ? row.user_code : null, verificationUri: row.verification_uri || "https://www.microsoft.com/link", message, username: row.username || null, updatedAt: row.updated_at });
  } catch (error) {
    console.error("Could not load bot auth status:", error.message);
    return res.status(500).json({ reason: "Could not load bot sign-in status" });
  }
});

app.post("/api/payment-transactions", async (req, res) => {
  const session = sessionFor(req);
  const { amount } = req.body || {};

  if (!session) return reject(res, null, "UNAUTHENTICATED", "Authentication required", 401);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return reject(res, null, "INVALID_AMOUNT", "Amount must be a positive integer");
  }
  if (BigInt(amount) < CONFIG.minimumBet) {
    return reject(res, null, "BELOW_MINIMUM", "Minimum amount is 100k");
  }
  if (BigInt(amount) > CONFIG.maximumBet) {
    return reject(res, null, "ABOVE_MAXIMUM", "Maximum amount is 2m");
  }
  if (rateLimited("payment:" + session.playerUuid)) {
    return reject(res, null, "RATE_LIMITED", "Too many requests; try again shortly", 429);
  }

  const transactionId = crypto.randomUUID();
  try {
    if (pool) {
      await pool.query(
        "INSERT INTO payment_transactions(transaction_id, player_uuid, username, target, amount) VALUES($1, $2, $3, $4, $5)",
        [transactionId, session.playerUuid, session.username, CONFIG.paymentTarget, String(amount)]
      );
    } else {
      memoryPaymentTransactions.set(transactionId, {
        playerUuid: session.playerUuid,
        username: session.username,
        target: CONFIG.paymentTarget,
        amount,
        status: "recorded"
      });
    }

    return res.status(201).json({
      accepted: true,
      transactionId,
      target: CONFIG.paymentTarget,
      amount,
      status: "recorded"
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      accepted: false,
      transactionId,
      code: "SERVER_ERROR",
      reason: "Could not record payment transaction"
    });
  }
});

app.post("/api/payment-transactions/:transactionId/confirm", async (req, res) => {
  const session = sessionFor(req);
  const { transactionId } = req.params;
  if (!session) return reject(res, transactionId, "UNAUTHENTICATED", "Authentication required", 401);
  if (!uuidV4(transactionId)) return reject(res, transactionId, "INVALID_TRANSACTION_ID", "Invalid transaction ID");
  try {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = await client.query("SELECT player_uuid,username,amount,status FROM payment_transactions WHERE transaction_id=$1 FOR UPDATE", [transactionId]);
        if (!tx.rowCount || tx.rows[0].player_uuid !== session.playerUuid) {
          await client.query("ROLLBACK");
          return reject(res, transactionId, "TRANSACTION_NOT_FOUND", "Payment transaction was not found", 404);
        }
        const row = tx.rows[0];
        await client.query("INSERT INTO players(uuid,username,balance) VALUES($1,$2,0) ON CONFLICT(uuid) DO UPDATE SET username=EXCLUDED.username", [session.playerUuid, session.username]);
        if (row.status !== "paid") {
          await client.query("UPDATE players SET balance=balance+$1::bigint WHERE uuid=$2", [String(row.amount), session.playerUuid]);
          await client.query("UPDATE payment_transactions SET status='paid' WHERE transaction_id=$1", [transactionId]);
        }
        const balance = await client.query("SELECT balance FROM players WHERE uuid=$1", [session.playerUuid]);
        await client.query("COMMIT");
        return res.json({ accepted: true, transactionId, balance: String(balance.rows[0].balance), replayed: row.status === "paid" });
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const tx = memoryPaymentTransactions.get(transactionId);
    if (!tx || tx.playerUuid !== session.playerUuid) return reject(res, transactionId, "TRANSACTION_NOT_FOUND", "Payment transaction was not found", 404);
    const replayed = tx.status === "paid";
    if (!replayed) {
      memoryBalances.set(session.playerUuid, (memoryBalances.get(session.playerUuid) ?? 0n) + BigInt(tx.amount));
      tx.status = "paid";
    }
    return res.json({ accepted: true, transactionId, balance: String(memoryBalances.get(session.playerUuid) ?? 0n), replayed });
  } catch (error) {
    console.error("Could not confirm payment transaction:", error);
    return res.status(500).json({ accepted: false, transactionId, code: "SERVER_ERROR", reason: "Could not confirm payment" });
  }
});

app.post("/api/bet", async (req, res) => {
  const session = sessionFor(req);
  const { transactionId, game, bet, selection = null } = req.body || {};

  if (!session) return reject(res, transactionId, "UNAUTHENTICATED", "Authentication required", 401);
  if (!uuidV4(transactionId)) return reject(res, transactionId, "INVALID_TRANSACTION_ID", "transactionId must be UUID v4");
  if (!CONFIG.enabledGames.includes(game)) return reject(res, transactionId, "GAME_DISABLED", "Game is disabled");
  if (!Number.isSafeInteger(bet) || bet < 0) return reject(res, transactionId, "ABOVE_MAXIMUM", "Bet must be a non-negative integer");

  const isCrate = game === "crates";
  const betAmount = BigInt(bet);
  if (isCrate ? bet !== 0 : (betAmount < CONFIG.minimumBet || betAmount > CONFIG.maximumBet)) {
    return reject(res, transactionId,
      betAmount < CONFIG.minimumBet ? "BELOW_MINIMUM" : "ABOVE_MAXIMUM",
      betAmount < CONFIG.minimumBet ? "Minimum bet is 100k" : "Maximum bet is 2m");
  }
  if (!legalSelection(game, selection)) return reject(res, transactionId, "INVALID_SELECTION", "Selection is not legal for this game");
  if (rateLimited(session.playerUuid)) return reject(res, transactionId, "RATE_LIMITED", "Too many requests; try again shortly", 429);

  const request = { game, bet, selection };
  const key = session.playerUuid + ":" + transactionId;

  try {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const previous = await client.query(
          "SELECT request,response FROM transactions WHERE player_uuid=$1 AND transaction_id=$2 FOR UPDATE",
          [session.playerUuid, transactionId]
        );
        if (previous.rowCount) {
          const same = JSON.stringify(previous.rows[0].request) === JSON.stringify(request);
          if (!same) {
            await client.query("ROLLBACK");
            return reject(res, transactionId, "TRANSACTION_CONFLICT", "Transaction parameters conflict", 409);
          }
          await client.query("COMMIT");
          return res.json({ ...previous.rows[0].response, replayed: true });
        }

        await client.query(
          "INSERT INTO players(uuid,username,balance) VALUES($1,$2,0) ON CONFLICT(uuid) DO UPDATE SET username=EXCLUDED.username",
          [session.playerUuid, session.username]
        );
        const player = await client.query("SELECT balance FROM players WHERE uuid=$1 FOR UPDATE", [session.playerUuid]);
        const balance = BigInt(player.rows[0].balance);
        const cost = isCrate ? CONFIG.cratePrices[selection] : betAmount;
        if (balance < cost) {
          await client.query("ROLLBACK");
          return reject(res, transactionId, "INSUFFICIENT_BALANCE", "Insufficient balance");
        }

        const outcome = resolveGame(game, betAmount, selection);
        const newBalance = balance - cost;
        const response = buildResponse(transactionId, outcome, isCrate ? 0 : bet, newBalance);
        if (outcome.payout > 0n) {
          const payoutJobId = crypto.randomUUID();
          response.payoutJobId = payoutJobId;
          await client.query(
            "INSERT INTO bot_payment_jobs(job_id,request_id,player,amount,status,requested_by) VALUES($1,$2,$3,$4,'queued','game payout')",
            [payoutJobId, crypto.randomUUID(), session.username, outcome.payout.toString()]
          );
        }

        await client.query("UPDATE players SET balance=$1 WHERE uuid=$2", [newBalance.toString(), session.playerUuid]);
        await client.query(
          "INSERT INTO transactions(player_uuid,transaction_id,request,response) VALUES($1,$2,$3,$4)",
          [session.playerUuid, transactionId, request, response]
        );
        await client.query("COMMIT");
        return res.json(response);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const previous = memoryTransactions.get(key);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
        return reject(res, transactionId, "TRANSACTION_CONFLICT", "Transaction parameters conflict", 409);
      }
      return res.json({ ...previous.response, replayed: true });
    }

    const balance = memoryBalances.get(session.playerUuid) ?? 0n;
    const cost = isCrate ? CONFIG.cratePrices[selection] : betAmount;
    if (balance < cost) return reject(res, transactionId, "INSUFFICIENT_BALANCE", "Insufficient balance");

    const outcome = resolveGame(game, betAmount, selection);
    const newBalance = balance - cost + outcome.payout;
    const response = buildResponse(transactionId, outcome, isCrate ? 0 : bet, newBalance);
    memoryBalances.set(session.playerUuid, newBalance);
    memoryTransactions.set(key, { request, response });
    return res.json(response);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ accepted: false, transactionId, code: "SERVER_ERROR", reason: "Internal server error" });
  }
});

function resolveGame(game, bet, selection) {
  let result = "LOSE";
  let multiplierBasisPoints = 0;
  let detail = {};

  if (game === "50_50") {
    result = randomInt(100) < CONFIG.fiftyFiftyWinPercent ? "WIN" : "LOSE";
    multiplierBasisPoints = CONFIG.multipliers["50_50"][result];
  } else if (game === "45_45_10") {
    const roll = randomInt(100);
    if (roll < 5) result = "JACKPOT";
    else if (roll < 40) result = "WIN";
    multiplierBasisPoints = CONFIG.multipliers["45_45_10"][result];
  } else if (game === "oddEven") {
    const win = randomInt(10000) < 3000;
    let number;
    do {
      number = 1 + randomInt(10);
    } while (win ? ((number % 2 === 0) !== (selection === "even")) : ((number % 2 === 0) === (selection === "even")));
    detail = { number, parity: number % 2 === 0 ? "even" : "odd" };
    result = win ? "WIN" : "LOSE";
    multiplierBasisPoints = CONFIG.multipliers.oddEven[result];
  } else if (game === "wheel") {
    const layout = makeWheelLayout();
    const slot = randomInt(25);
    const multiplier = layout[slot];
    multiplierBasisPoints = { "0x": 0, "0.5x": 5000, "1x": 10000, "1.5x": 15000, "2x": 20000, "3x": 30000 }[multiplier];
    result = multiplierBasisPoints === 0 ? "LOSE" : "WIN";
    detail = { layout, slot };
  } else if (game === "horseRacing") {
    const finishOrder = ["diamond", "iron", "gold"];
    for (let i = finishOrder.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [finishOrder[i], finishOrder[j]] = [finishOrder[j], finishOrder[i]];
    }
    detail = { winner: finishOrder[0], finishOrder };
    result = selection === finishOrder[0] ? "WIN" : "LOSE";
    multiplierBasisPoints = CONFIG.multipliers.horseRacing[result];
  } else if (game === "crates") {
    const rows = crateRows[selection];
    const reward = rows[weightedIndex(crateWeights[selection])];
    const items = Object.fromEntries(rows.map(row => [row[0], {
      id: row[0], name: row[1], icon: row[2], count: row[3], value: row[4], rarity: row[5]
    }]));
    const ids = rows.map(row => row[0]);
    const reel = Array.from({ length: 70 }, () => ids[weightedIndex(crateWeights[selection])]);
    const slot = 8 + randomInt(54);
    reel[slot] = reward[0];
    detail = { crate: selection, items, reel, slot, reward: reward[0] };
    result = reward[5] === "jackpot" ? "JACKPOT" : "WIN";
    return { result, payout: BigInt(reward[4]), multiplier: null, multiplierBasisPoints: null, detail };
  }

  return {
    result,
    payout: payoutFromBasisPoints(bet, multiplierBasisPoints),
    multiplier: multiplierText(multiplierBasisPoints),
    multiplierBasisPoints,
    detail
  };
}

function buildResponse(transactionId, outcome, bet, balance) {
  return jsonSafe({
    accepted: true,
    transactionId,
    result: outcome.result,
    bet,
    payout: outcome.payout,
    multiplier: outcome.multiplier,
    multiplierBasisPoints: outcome.multiplierBasisPoints,
    balance,
    replayed: false,
    detail: outcome.detail
  });
}

process.once("SIGTERM", () => { if (botProcess && botProcess.exitCode === null) botProcess.kill("SIGTERM"); });
process.once("SIGINT", () => { if (botProcess && botProcess.exitCode === null) botProcess.kill("SIGINT"); });

ensureSchema()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("DonutSMP Game Hub API listening on " + PORT)))
  .catch(error => { console.error(error); process.exit(1); });
