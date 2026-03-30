"use strict";

// ============================================================
// Minecraft AFK Bot v3.0 — Human-Like Edition
// Optimized for: Paper + NCP, Minecraft 1.21.x
// Anti-AFK: Weighted random behavior engine, NCP-safe movement
// ============================================================

const mineflayer  = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const express     = require("express");
const fs          = require("fs");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync("settings.json", "utf8"));

// ── STATE ─────────────────────────────────────────────────────────────────────
let bot             = null;
let isReconnecting  = false;
let reconnectTid    = null;
let connTimeoutTid  = null;
let activeIntervals = [];
let logs            = [];
let lastBehavior    = null;   // prevents same behavior twice in a row
let behaviorTid     = null;   // handle for next scheduled behavior

const botState = {
  connected:         false,
  lastActivity:      Date.now(),
  reconnectAttempts: 0,
  spawnTime:         null,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const rand    = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 300) logs.shift();
}

function addInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

function clearAllIntervals() {
  activeIntervals.forEach(clearInterval);
  activeIntervals = [];
  if (behaviorTid) { clearTimeout(behaviorTid); behaviorTid = null; }
}

// ── WEB DASHBOARD ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:16px;font-size:14px}
h1{color:#4ade80;margin-bottom:16px;font-size:16px;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.card{background:#1e293b;border-radius:8px;padding:12px}
.lbl{color:#64748b;font-size:11px;margin-bottom:4px;text-transform:uppercase}
.val{color:#4ade80;font-size:18px;font-weight:bold}
.val.sm{font-size:12px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.on{background:#4ade80}.off{background:#f87171}
#log{background:#1e293b;border-radius:8px;padding:12px;height:260px;overflow-y:auto;font-size:11px;line-height:1.7}
.ll{color:#94a3b8}
.row{display:flex;gap:8px;margin-top:10px}
input{flex:1;background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-family:monospace;font-size:13px}
button{background:#4ade80;color:#0f172a;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-weight:bold}
</style>
</head>
<body>
<h1>🤖 AFK BOT DASHBOARD</h1>
<div class="grid">
  <div class="card"><div class="lbl">Status</div><div class="val" id="st">—</div></div>
  <div class="card"><div class="lbl">Last Action</div><div class="val" id="la">—</div></div>
  <div class="card"><div class="lbl">Reconnects</div><div class="val" id="rc">0</div></div>
  <div class="card"><div class="lbl">Server</div><div class="val sm" id="sv">—</div></div>
</div>
<div id="log"></div>
<div class="row">
  <input id="ci" placeholder="Type a command..." onkeydown="if(event.key==='Enter')go()">
  <button onclick="go()">Send</button>
</div>
<script>
function go(){
  const v=document.getElementById('ci').value.trim();
  if(!v)return;
  fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:v})});
  document.getElementById('ci').value='';
}
async function tick(){
  try{
    const d=await(await fetch('/api/status')).json();
    document.getElementById('st').innerHTML='<span class="dot '+(d.online?'on':'off')+'"></span>'+(d.online?'Online':'Offline');
    document.getElementById('la').textContent=d.lastActivity?Math.round((Date.now()-d.lastActivity)/1000)+'s ago':'—';
    document.getElementById('rc').textContent=d.reconnects;
    document.getElementById('sv').textContent=d.server;
    const el=document.getElementById('log');
    el.innerHTML=d.logs.map(l=>'<div class="ll">'+l.replace(/</g,'&lt;')+'</div>').join('');
    el.scrollTop=el.scrollHeight;
  }catch(e){}
}
setInterval(tick,2000);tick();
</script>
</body>
</html>`;

app.get("/",           (_,res) => res.send(HTML));
app.get("/api/status", (_,res) => res.json({
  online:       botState.connected,
  lastActivity: botState.lastActivity,
  reconnects:   botState.reconnectAttempts,
  server:       `${config.server.ip}:${config.server.port}`,
  logs:         logs.slice(-100),
}));
app.post("/api/cmd", (req, res) => {
  const cmd = req.body?.cmd;
  if (cmd && bot && botState.connected) {
    try { bot.chat(cmd); addLog(`[CMD] ${cmd}`); } catch(e) {}
  }
  res.json({ ok: true });
});

app.listen(5000, () => addLog("[Server] Dashboard on port 5000"));

// ── RECONNECT ─────────────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;
  const base  = config.utils?.["auto-reconnect-delay"] ?? 5000;
  const max   = config.utils?.["max-reconnect-delay"]  ?? 120000;
  const delay = Math.min(base * Math.pow(1.5, botState.reconnectAttempts - 1), max)
              + rand(0, 3000);
  addLog(`[Bot] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${botState.reconnectAttempts})`);
  reconnectTid = setTimeout(() => {
    isReconnecting = false;
    reconnectTid   = null;
    createBot();
  }, delay);
}

// ── HUMAN-LIKE ANTI-AFK ENGINE ────────────────────────────────────────────────
//
//  How it works:
//  • A weighted pool of human behaviors — each fires with different probability
//  • No behavior fires twice in a row (lastBehavior guard)
//  • Timing between actions: 40–160 seconds (totally random each time)
//  • Emergency guard: if 4 min pass with no activity, act IMMEDIATELY
//    (server kicks at 5 min — this gives a 60-second safety margin)
//  • NCP-safe rules enforced per behavior (see comments below)
//
const BEHAVIORS = [
  { name: "lookAround",   weight: 28 },  // most common — zero movement flags
  { name: "microStep",    weight: 20 },  // pathfinder = valid physics, no SurvivalFly
  { name: "sneakBrief",   weight: 15 },  // sneak + walk forward — visible crouch walk
  { name: "hotbarSwitch", weight: 12 },  // slot switch — NCP doesn't flag this
  { name: "swingArm",     weight:  9 },  // arm swing packet — totally safe
  { name: "jumpOnce",     weight:  8 },  // jump while walking — looks natural
  { name: "sprintBurst",  weight: 12 },  // short sprint burst — very human-like
];

const MAX_IDLE_MS = 4 * 60 * 1000; // 4 min — kick is at 5 min

function pickBehavior() {
  // Exclude last behavior so we never do the same thing twice
  const pool  = BEHAVIORS.filter(b => b.name !== lastBehavior);
  const total = pool.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of pool) {
    r -= b.weight;
    if (r <= 0) return b.name;
  }
  return pool[0].name;
}

async function executeBehavior(name, defaultMove) {
  if (!bot || !botState.connected || !bot.entity) return;
  try {
    switch (name) {

      case "lookAround": {
        // Rotate head to a new random yaw
        // Pitch kept near 0 (±0.15 rad) — NCP flags wild vertical movement
        const yaw   = Math.random() * Math.PI * 2;
        const pitch = rand(-0.15, 0.10);
        await bot.look(yaw, pitch, true);
        addLog("[AntiAFK] Looked around");
        break;
      }

      case "microStep": {
        // Walk 2–5 blocks in a random direction via pathfinder
        // Pathfinder produces correct ground-movement packets — no SurvivalFly
        const yaw  = Math.random() * Math.PI * 2;
        const dist = randInt(2, 5);
        const tx   = Math.floor(bot.entity.position.x + Math.cos(yaw) * dist);
        const tz   = Math.floor(bot.entity.position.z + Math.sin(yaw) * dist);
        const ty   = Math.floor(bot.entity.position.y);
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, 1));
        // Let pathfinder walk, then clear goal after random duration
        await new Promise(r => setTimeout(r, rand(1200, 3500)));
        if (bot) bot.pathfinder.setGoal(null);
        addLog("[AntiAFK] Micro-stepped");
        break;
      }

      case "sneakBrief": {
        if (typeof bot.setControlState !== "function") break;
        // Look in a random direction, then crouch-walk forward — actually visible
        const sneakYaw = Math.random() * Math.PI * 2;
        await bot.look(sneakYaw, 0, true);
        bot.pathfinder.setGoal(null); // stop pathfinder so control states work
        await new Promise(r => setTimeout(r, 150));
        bot.setControlState("sneak", true);
        bot.setControlState("forward", true);
        await new Promise(r => setTimeout(r, rand(1000, 2500)));
        if (bot) {
          bot.setControlState("forward", false);
          bot.setControlState("sneak", false);
        }
        addLog("[AntiAFK] Sneaked briefly");
        break;
      }

      case "hotbarSwitch": {
        const slot = randInt(0, 8);
        bot.setQuickBarSlot(slot);
        addLog(`[AntiAFK] Slot → ${slot + 1}`);
        break;
      }

      case "swingArm": {
        bot.swingArm("right");
        addLog("[AntiAFK] Swung arm");
        break;
      }

      case "jumpOnce": {
        // Jump while walking forward — NCP-safe: not sprinting, just a walking jump
        if (typeof bot.setControlState !== "function") break;
        bot.pathfinder.setGoal(null);
        const jumpYaw = Math.random() * Math.PI * 2;
        await bot.look(jumpYaw, 0, true);
        await new Promise(r => setTimeout(r, 200));
        bot.setControlState("forward", true);
        bot.setControlState("jump", true);
        await new Promise(r => setTimeout(r, rand(400, 700)));
        if (bot) {
          bot.setControlState("jump", false);
          // Keep walking briefly after landing (natural momentum)
          await new Promise(r => setTimeout(r, rand(300, 600)));
          if (bot) bot.setControlState("forward", false);
        }
        addLog("[AntiAFK] Jumped");
        break;
      }

      case "sprintBurst": {
        // Short sprint in a random direction — NCP-safe: ≤2s, no jump during sprint
        if (typeof bot.setControlState !== "function") break;
        bot.pathfinder.setGoal(null);
        const sprintYaw = Math.random() * Math.PI * 2;
        await bot.look(sprintYaw, 0, true);
        await new Promise(r => setTimeout(r, 300)); // settle before sprinting
        bot.setControlState("sprint", true);
        bot.setControlState("forward", true);
        await new Promise(r => setTimeout(r, rand(800, 1800)));
        if (bot) {
          bot.setControlState("sprint", false);
          bot.setControlState("forward", false);
        }
        addLog("[AntiAFK] Sprint burst");
        break;
      }
    }

    lastBehavior          = name;
    botState.lastActivity = Date.now();
  } catch (e) {
    addLog(`[AntiAFK] Error in ${name}: ${e.message}`);
  }
}

function scheduleNextBehavior(defaultMove) {
  if (!bot || !botState.connected) return;

  const idle = Date.now() - botState.lastActivity;

  // Emergency: act immediately if getting close to AFK kick threshold
  if (idle > MAX_IDLE_MS - 30000) {
    addLog("[AntiAFK] ⚠️ Near AFK limit — acting now");
    executeBehavior(pickBehavior(), defaultMove)
      .then(() => scheduleNextBehavior(defaultMove));
    return;
  }

  // Normal: wait a random 40–160 seconds before next action
  // Wide range = unpredictable pattern anti-cheat can't time
  const delay = rand(40000, 160000);

  behaviorTid = setTimeout(() => {
    if (!bot || !botState.connected) return;
    const name = pickBehavior();
    executeBehavior(name, defaultMove)
      .then(() => scheduleNextBehavior(defaultMove));
  }, delay);
}

// ── AUTO-AUTH ──────────────────────────────────────────────────────────────────
function setupAutoAuth() {
  if (!config.utils?.["auto-auth"]?.enabled) return;
  const pw = config.utils["auto-auth"].password;
  let done = false;

  bot.on("messagestr", (msg) => {
    if (done) return;
    const m = msg.toLowerCase();
    if (m.includes("/register") || m.includes("register")) {
      done = true;
      bot.chat(`/register ${pw} ${pw}`);
      addLog("[Auth] Sent /register");
    } else if (m.includes("/login") || m.includes("login")) {
      done = true;
      bot.chat(`/login ${pw}`);
      addLog("[Auth] Sent /login");
    }
  });

  // Fallback if no prompt arrives
  setTimeout(() => {
    if (!done && bot && botState.connected) {
      done = true;
      bot.chat(`/login ${pw}`);
      addLog("[Auth] Sent /login (fallback)");
    }
  }, 4000);
}

// ── COMBAT MODULE ──────────────────────────────────────────────────────────────
function setupCombat() {
  if (!config.modules?.combat) return;
  // Random interval between 700–1500ms to avoid rhythm detection
  addInterval(() => {
    if (!bot || !botState.connected || !bot.entity) return;
    try {
      const e = bot.nearestEntity(e =>
        (e.type === "mob" || e.type === "player") &&
        e.username !== bot.username &&
        bot.entity.position.distanceTo(e.position) < 4
      );
      if (e) {
        bot.lookAt(e.position.offset(0, e.height ?? 1.8, 0), true);
        bot.attack(e);
      }
    } catch (_) {}
  }, randInt(700, 1500));
}

// ── AUTO-EAT ───────────────────────────────────────────────────────────────────
function setupAutoEat(mc) {
  if (!config.combat?.["auto-eat"]) return;
  addInterval(() => {
    if (!bot || !botState.connected || bot.food >= 18) return;
    try {
      const food = bot.inventory.items().find(i => mc.itemsByName[i.name]?.food);
      if (food) {
        bot.equip(food, "hand")
          .then(() => {
            bot.activateItem();
            setTimeout(() => { if (bot) bot.deactivateItem(); }, 1600);
            addLog(`[AutoEat] Eating ${food.name} (food: ${bot.food})`);
          })
          .catch(() => {});
      }
    } catch (_) {}
  }, 5000);
}

// ── CHAT MESSAGES ──────────────────────────────────────────────────────────────
function setupChatMessages() {
  const cfg = config.utils?.["chat-messages"];
  if (!cfg?.enabled || !cfg.repeat || !cfg.messages?.length) return;

  const msgs    = cfg.messages;
  const baseMs  = (cfg["repeat-delay"] ?? 120) * 1000;
  let   idx     = 0;

  // ±25% jitter on every send — prevents admins timing the chat pattern
  const jitter = () => rand(-baseMs * 0.25, baseMs * 0.25);

  // Random initial delay so bot doesn't chat the moment it joins
  setTimeout(function send() {
    if (bot && botState.connected) {
      try {
        bot.chat(msgs[idx % msgs.length]);
        addLog(`[Chat] "${msgs[idx % msgs.length]}"`);
        idx++;
      } catch (_) {}
    }
    setTimeout(send, baseMs + jitter());
  }, rand(15000, Math.min(baseMs, 45000)));
}

// ── BOT CREATION ───────────────────────────────────────────────────────────────
function createBot() {
  if (bot) {
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  const version = config.server.version?.trim() || false;

  try {
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth:     config["bot-account"].type,
      host:     config.server.ip,
      port:     config.server.port,
      version,
      hideErrors:            false,
      checkTimeoutInterval:  600000,
    });

    bot.loadPlugin(pathfinder);

    // Timeout for slow-starting servers (Aternos etc.)
    connTimeoutTid = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout — retrying");
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;
      clearTimeout(connTimeoutTid);

      botState.connected         = true;
      botState.lastActivity      = Date.now();
      botState.reconnectAttempts = 0;
      botState.spawnTime         = Date.now();
      isReconnecting             = false;

      addLog(`[Bot] [+] Spawned! Version: ${bot.version}`);

      // Build pathfinder movement config — NCP-safe settings
      const mc           = require("minecraft-data")(bot.version);
      const defaultMove  = new Movements(bot, mc);
      defaultMove.allowFreeMotion = false;  // no flying movement
      defaultMove.canDig          = false;  // don't break blocks
      defaultMove.allowParkour    = false;  // NCP flags parkour jumps
      defaultMove.liquidCost      = 1000;   // avoid water/lava
      defaultMove.fallDamageCost  = 1000;   // avoid falls

      // Wait 2s for server to finish loading chunks before doing anything
      setTimeout(() => {
        if (!bot || !botState.connected) return;

        setupAutoAuth();
        setupCombat();
        setupAutoEat(mc);
        setupChatMessages();

        // Start anti-AFK engine after a random human-like delay
        const afkStart = rand(8000, 20000);
        addLog(`[AntiAFK] Engine starting in ${(afkStart/1000).toFixed(1)}s`);
        setTimeout(() => {
          if (bot && botState.connected) {
            addLog("[AntiAFK] Human-like behavior engine active");
            scheduleNextBehavior(defaultMove);
          }
        }, afkStart);

        addLog("[Modules] All modules initialized!");
      }, 2000);
    });

    bot.on("kicked", (reason) => {
      const r = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
      addLog(`[Bot] Kicked: ${r}`);
      botState.connected = false;
      clearAllIntervals();
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "unknown"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      scheduleReconnect();
    });

    bot.on("error", (err) => {
      addLog(`[Bot] Error: ${err.message}`);
    });

    bot._client?.on("error", (err) => {
      addLog(`[Packet] Error (kept alive): ${err.message}`);
    });

  } catch (err) {
    addLog(`[Bot] Failed to create: ${err.message}`);
    scheduleReconnect();
  }
}

// ── PROCESS GUARDS ─────────────────────────────────────────────────────────────
process.on("uncaughtException",  (e) => addLog(`[Process] Uncaught exception: ${e.message}`));
process.on("unhandledRejection", (r) => addLog(`[Process] Unhandled rejection: ${r}`));

// ── START ──────────────────────────────────────────────────────────────────────
addLog("=".repeat(52));
addLog("  Minecraft AFK Bot v3.0 — Human-Like Edition");
addLog("  Optimized: Paper + NCP | 1.21.x");
addLog("=".repeat(52));
addLog(`[Config] Server:  ${config.server.ip}:${config.server.port}`);
addLog(`[Config] Version: ${config.server.version || "auto-detect"}`);
addLog(`[Config] Auth:    ${config["bot-account"].type}`);

createBot();
