import express from "express";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
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
    enabledGames: CONFIG.enabledGames
  };
}
function applyAdminConfig(value) {
  CONFIG = {
    ...CONFIG,
    minimumBet: BigInt(value.minimumBet),
    maximumBet: BigInt(value.maximumBet),
    paymentTarget: value.paymentTarget,
    showOdds: value.showOdds,
    enabledGames: value.enabledGames
  };
}
async function loadAdminConfig() {
  if (!pool) {
    memoryAdminConfig ??= adminConfigValues();
    applyAdminConfig(memoryAdminConfig);
    return;
  }
  await pool.query("CREATE TABLE IF NOT EXISTS admin_config(id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id IS TRUE), minimum_bet BIGINT NOT NULL, maximum_bet BIGINT NOT NULL, payment_target TEXT NOT NULL, show_odds BOOLEAN NOT NULL DEFAULT FALSE, enabled_games JSONB NOT NULL)");
  const defaults = adminConfigValues();
  await pool.query(
    "INSERT INTO admin_config(id, minimum_bet, maximum_bet, payment_target, show_odds, enabled_games) VALUES(TRUE, $1, $2, $3, $4, $5::jsonb) ON CONFLICT(id) DO NOTHING",
    [String(defaults.minimumBet), String(defaults.maximumBet), defaults.paymentTarget, defaults.showOdds, JSON.stringify(defaults.enabledGames)]
  );
  const result = await pool.query("SELECT minimum_bet, maximum_bet, payment_target, show_odds, enabled_games FROM admin_config WHERE id=TRUE");
  const row = result.rows[0];
  applyAdminConfig({
    minimumBet: Number(row.minimum_bet),
    maximumBet: Number(row.maximum_bet),
    paymentTarget: row.payment_target,
    showOdds: row.show_odds,
    enabledGames: row.enabled_games
  });
}
async function ensureSchema() {
  if (pool) {
    await pool.query("CREATE TABLE IF NOT EXISTS players(uuid TEXT PRIMARY KEY, username TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0)");
    await pool.query("CREATE TABLE IF NOT EXISTS transactions(player_uuid TEXT NOT NULL, transaction_id UUID NOT NULL, request JSONB NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(player_uuid, transaction_id))");
    await pool.query("CREATE TABLE IF NOT EXISTS payment_transactions(transaction_id UUID PRIMARY KEY, player_uuid TEXT NOT NULL, username TEXT NOT NULL, target TEXT NOT NULL, amount BIGINT NOT NULL CHECK (amount > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
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
    cratePrices: Object.fromEntries(Object.entries(CONFIG.cratePrices).map(([k, v]) => [k, Number(v)]))
  };
  if (CONFIG.showOdds) response.oddsBasisPoints = CONFIG.oddsBasisPoints;
  res.json(response);
});

const ADMIN_PAGE = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Game Hub Admin</title>\n<style>\n*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0d0d12;color:#fff;font:16px Arial,sans-serif;display:grid;place-items:center;padding:20px}\nmain{width:min(620px,100%);background:#17171f;border:1px solid #363644;border-radius:16px;padding:24px;box-shadow:0 18px 55px #0008}\nh1{margin:0 0 8px}p{color:#aaaab8;margin:0 0 18px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:block;color:#aaaab8;font-size:13px;font-weight:bold;margin:12px 0}input{display:block;width:100%;margin-top:6px;padding:11px;border:1px solid #363644;border-radius:8px;background:#101017;color:white;font-size:16px}\nbutton{border:0;border-radius:9px;padding:12px 16px;color:white;background:#5865f2;font-weight:bold;font-size:15px;cursor:pointer;margin-top:10px}button.secondary{background:#30303a;margin-left:8px}.games{display:grid;grid-template-columns:1fr 1fr;gap:8px}.games label{margin:3px 0;color:#eee}.games input{display:inline-block;width:auto;margin:0 8px 0 0}.notice{min-height:24px;margin-top:12px;color:#aaaab8}.error{color:#f87171}.success{color:#4ade80}[hidden]{display:none!important}@media(max-width:480px){.row{grid-template-columns:1fr}}\n</style></head><body><main>\n<h1>Game Hub Admin</h1><p>Sign in to edit the server configuration.</p>\n<form id=\"login\"><label>Admin password<input id=\"password\" type=\"password\" autocomplete=\"current-password\" required></label><button type=\"submit\">Unlock settings</button></form>\n<form id=\"settings\" hidden>\n<div class=\"row\"><label>Minimum amount<input id=\"minimumBet\" inputmode=\"numeric\" type=\"number\" min=\"1\" required></label><label>Maximum amount<input id=\"maximumBet\" inputmode=\"numeric\" type=\"number\" min=\"1\" required></label></div>\n<label>Payment target<input id=\"paymentTarget\" maxlength=\"16\" required></label>\n<label><input id=\"showOdds\" type=\"checkbox\"> Show odds in the mod</label>\n<div><strong>Enabled games</strong><div id=\"games\" class=\"games\"></div></div>\n<button type=\"submit\">Save configuration</button><button class=\"secondary\" id=\"logout\" type=\"button\">Lock</button>\n</form><div id=\"notice\" class=\"notice\"></div>\n</main><script>\nconst ids=[\"50_50\",\"wheel\",\"crates\",\"horseRacing\",\"45_45_10\",\"oddEven\"];\nconst labels={\"50_50\":\"50/50\",wheel:\"Wheel\",crates:\"Crates\",horseRacing:\"Horse Racing\",\"45_45_10\":\"45/45/10\",oddEven:\"Odd or Even\"};\nconst login=document.getElementById(\"login\"),settings=document.getElementById(\"settings\"),notice=document.getElementById(\"notice\");\nfor(const id of ids){const label=document.createElement(\"label\");const input=document.createElement(\"input\");input.type=\"checkbox\";input.name=\"enabledGames\";input.value=id;label.append(input,document.createTextNode(labels[id]));document.getElementById(\"games\").append(label);}\nfunction say(text,kind){notice.textContent=text;notice.className=\"notice \"+(kind||\"\");}\nasync function api(path,options){const response=await fetch(path,Object.assign({credentials:\"same-origin\",headers:{\"Content-Type\":\"application/json\"}},options||{}));const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.reason||\"Request failed (\"+response.status+\")\");return data;}\nasync function load(){const value=await api(\"/api/admin/config\");document.getElementById(\"minimumBet\").value=value.minimumBet;document.getElementById(\"maximumBet\").value=value.maximumBet;document.getElementById(\"paymentTarget\").value=value.paymentTarget;document.getElementById(\"showOdds\").checked=value.showOdds;document.querySelectorAll(\"[name=enabledGames]\").forEach(box=>box.checked=value.enabledGames.includes(box.value));login.hidden=true;settings.hidden=false;say(\"Configuration loaded.\",\"success\");}\nlogin.addEventListener(\"submit\",async event=>{event.preventDefault();say(\"Checking password...\");try{await api(\"/api/admin/login\",{method:\"POST\",body:JSON.stringify({password:document.getElementById(\"password\").value})});document.getElementById(\"password\").value=\"\";await load();}catch(error){say(error.message,\"error\");}});\nsettings.addEventListener(\"submit\",async event=>{event.preventDefault();const body={minimumBet:Number(document.getElementById(\"minimumBet\").value),maximumBet:Number(document.getElementById(\"maximumBet\").value),paymentTarget:document.getElementById(\"paymentTarget\").value.trim(),showOdds:document.getElementById(\"showOdds\").checked,enabledGames:Array.from(document.querySelectorAll(\"[name=enabledGames]:checked\"),box=>box.value)};try{await api(\"/api/admin/config\",{method:\"PUT\",body:JSON.stringify(body)});say(\"Configuration saved.\",\"success\");}catch(error){say(error.message,\"error\");}});\ndocument.getElementById(\"logout\").addEventListener(\"click\",async()=>{try{await api(\"/api/admin/logout\",{method:\"POST\"});}finally{settings.hidden=true;login.hidden=false;say(\"Settings locked.\");}});\napi(\"/api/admin/config\").then(load).catch(error=>{if(!/Unauthorized/.test(error.message))say(error.message,\"error\");});\n</script></body></html>";
function adminSession(req) {
  const match = (req.headers.cookie || "").match(/(?:^|;\\s*)gamehub_admin=([^;]+)/);
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
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return res.type("html").send(ADMIN_PAGE);
});
app.post("/api/admin/login", (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ reason: "Admin password is not configured on the server" });
  const now = Date.now();
  for (const [key, times] of adminLoginAttempts) {
    const recent = times.filter(time => now - time < 600000);
    if (recent.length) adminLoginAttempts.set(key, recent); else adminLoginAttempts.delete(key);
  }
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const attempts = (adminLoginAttempts.get(key) || []).filter(time => now - time < 600000);
  if (attempts.length >= 10) return res.status(429).json({ reason: "Too many attempts; wait before trying again" });
  attempts.push(now);
  adminLoginAttempts.set(key, attempts);

  const supplied = typeof req.body?.password === "string" ? req.body.password : "";
  const expectedDigest = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD).digest();
  const suppliedDigest = crypto.createHash("sha256").update(supplied).digest();
  if (!crypto.timingSafeEqual(expectedDigest, suppliedDigest)) return res.status(401).json({ reason: "Incorrect password" });

  for (const [token, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(token);
  const token = crypto.randomBytes(32).toString("base64url");
  adminSessions.set(token, { expiresAt: now + 8 * 60 * 60 * 1000 });
  res.set("Cache-Control", "no-store");
  res.set("Set-Cookie", "gamehub_admin=" + token + "; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800");
  return res.json({ authenticated: true });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  const match = (req.headers.cookie || "").match(/(?:^|;\\s*)gamehub_admin=([^;]+)/);
  if (match) adminSessions.delete(match[1]);
  res.set("Set-Cookie", "gamehub_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  return res.json({ authenticated: false });
});
app.get("/api/admin/config", requireAdmin, (req, res) => res.set("Cache-Control", "no-store").json(adminConfigValues()));
app.put("/api/admin/config", requireAdmin, async (req, res) => {
  if (!sameAdminOrigin(req)) return res.status(403).json({ reason: "Invalid request origin" });
  const { minimumBet, maximumBet, paymentTarget, showOdds, enabledGames } = req.body || {};
  const validName = typeof paymentTarget === "string" && /^\\.?[A-Za-z0-9_]{3,16}$/.test(paymentTarget);
  if (!Number.isSafeInteger(minimumBet) || minimumBet < 1 ||
      !Number.isSafeInteger(maximumBet) || maximumBet < minimumBet ||
      !validName || typeof showOdds !== "boolean" ||
      !Array.isArray(enabledGames) || enabledGames.some(game => !CONFIG.enabledGames.includes(game)) ||
      new Set(enabledGames).size !== enabledGames.length) {
    return res.status(400).json({ reason: "Check the amount limits, Minecraft username, and enabled games" });
  }
  const next = { minimumBet, maximumBet, paymentTarget, showOdds, enabledGames };
  try {
    if (pool) {
      await pool.query(
        "INSERT INTO admin_config(id, minimum_bet, maximum_bet, payment_target, show_odds, enabled_games) VALUES(TRUE, $1, $2, $3, $4, $5::jsonb) ON CONFLICT(id) DO UPDATE SET minimum_bet=EXCLUDED.minimum_bet, maximum_bet=EXCLUDED.maximum_bet, payment_target=EXCLUDED.payment_target, show_odds=EXCLUDED.show_odds, enabled_games=EXCLUDED.enabled_games",
        [String(minimumBet), String(maximumBet), paymentTarget, showOdds, JSON.stringify(enabledGames)]
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
        amount
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
        const newBalance = balance - cost + outcome.payout;
        const response = buildResponse(transactionId, outcome, isCrate ? 0 : bet, newBalance);

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
    result = randomInt(10000) < 4000 ? "WIN" : "LOSE";
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

ensureSchema()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("DonutSMP Game Hub API listening on " + PORT)))
  .catch(error => { console.error(error); process.exit(1); });
