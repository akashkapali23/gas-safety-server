// ============================================================
// Gas Leak Detection System — Node.js Cloud Relay Server
// Stack  : Node.js + Express + Socket.io + Telegram Alerts
// Authors: Akash Kapali, Kisholoy Roy, Swayan Das, Praghya Roy
// ============================================================

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const https      = require("https");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// TELEGRAM CONFIGURATION
// ─────────────────────────────────────────────
const TELEGRAM_TOKEN   = "8786981395:AAFriEs3nD6rJQuUO9ckB0Dtp6VioO44GYo";
const TELEGRAM_CHAT_ID = "5007380331";

function sendTelegram(message) {
  const url  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" });
  const options = {
    method  : "POST",
    headers : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  };
  const req = https.request(url, options, (res) => {
    console.log(`[TELEGRAM] Sent. Status: ${res.statusCode}`);
  });
  req.on("error", (err) => console.error(`[TELEGRAM] Error: ${err.message}`));
  req.write(body);
  req.end();
}

// ─────────────────────────────────────────────
// Incident log
// ─────────────────────────────────────────────
const MAX_INCIDENTS   = 200;
let incidentLog       = [];
let lastIncidentState = "safe";

function recordIncident(data) {
  if (data.state === lastIncidentState) return;
  lastIncidentState = data.state;

  if (data.state === "safe") {
    sendTelegram(
      `✅ <b>GAS SAFETY — ALL CLEAR</b>\n\nSystem returned to SAFE state.\n` +
      `🌡 Temp: ${data.temp}°C | 💧 Humidity: ${data.humidity}%\n` +
      `🕐 ${new Date().toLocaleTimeString()}`
    );
    return;
  }

  incidentLog.unshift({
    id: Date.now(), time: new Date().toISOString(),
    state: data.state, mq2: data.mq2, mq135: data.mq135, mq6: data.mq6,
    temp: data.temp, humidity: data.humidity,
    regulator: data.regulator, alarm: data.alarm, fan: data.fan
  });
  if (incidentLog.length > MAX_INCIDENTS) incidentLog.pop();

  console.log(`[INCIDENT] ${data.state.toUpperCase()} at ${new Date().toLocaleTimeString()}`);

  const emoji = data.state === "danger" ? "🚨" : "⚠️";
  const label = data.state === "danger" ? "DANGER — GAS DETECTED!" : "WARNING — Gas Level Rising!";

  sendTelegram(
    `${emoji} <b>GAS SAFETY ALERT — ${label}</b>\n\n` +
    `📊 <b>Sensor Readings:</b>\n` +
    `• MQ-2  (LPG/Smoke) : ${data.mq2}\n` +
    `• MQ-6  (LPG Gas)   : ${data.mq6}\n` +
    `• MQ-135 (Air Qual) : ${data.mq135}\n\n` +
    `🌡 Temperature : ${data.temp}°C\n` +
    `💧 Humidity    : ${data.humidity}%\n\n` +
    `🔧 <b>System Status:</b>\n` +
    `• Regulator : ${data.regulator}\n` +
    `• Fan       : ${data.fan ? "ON" : "OFF"}\n` +
    `• Alarm     : ${data.alarm ? "ON" : "OFF"}\n\n` +
    `🕐 ${new Date().toLocaleTimeString()}\n` +
    `⚡ <b>Please take immediate action!</b>`
  );
}

// ─────────────────────────────────────────────
// In-memory sensor data store
// ─────────────────────────────────────────────
let latestData = {
  mq2: 0, mq135: 0, mq6: 0, temp: 0, humidity: 0,
  state: "safe", alarm: false, regulator: "OPEN",
  fan: false, manual: false, timestamp: null
};

let pendingCommand = null;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────
// POST /publish — ESP32 sends data here
// ─────────────────────────────────────────────
app.post("/publish", (req, res) => {
  const d = req.body;
  if (!d || typeof d !== "object") return res.status(400).json({ error: "Invalid body" });

  latestData = {
    mq2      : parseFloat(d.mq2)      || 0,
    mq135    : parseFloat(d.mq135)    || 0,
    mq6      : parseFloat(d.mq6)      || 0,
    temp     : parseFloat(d.temp)     || 0,
    humidity : parseFloat(d.humidity) || 0,
    state    : d.state     || "safe",
    alarm    : d.alarm     === true || d.alarm    === "true",
    regulator: d.regulator || "OPEN",
    fan      : d.fan       === true || d.fan      === "true",
    manual   : d.manual    === true || d.manual   === "true",
    timestamp: new Date().toISOString()
  };

  recordIncident(latestData);
  io.emit("sensorUpdate", latestData);
  console.log(`[PUBLISH] ${latestData.state.toUpperCase()} | MQ2=${latestData.mq2} MQ6=${latestData.mq6} MQ135=${latestData.mq135}`);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// POST /command — Dashboard queues a command
// ─────────────────────────────────────────────
app.post("/command", (req, res) => {
  const { action, ssid, password } = req.body;
  const VALID = ["reg_open","reg_close","fan_on","fan_off","alarm_on","alarm_off","reset","wifi_change"];
  if (!action || !VALID.includes(action))
    return res.status(400).json({ error: "Unknown action. Valid: " + VALID.join(", ") });

  // WiFi change command — requires ssid + password
  if (action === "wifi_change") {
    if (!ssid || !password)
      return res.status(400).json({ error: "wifi_change requires ssid and password fields" });
    if (ssid.length > 32 || password.length > 64)
      return res.status(400).json({ error: "SSID max 32 chars, password max 64 chars" });
    pendingCommand = { action, ssid, password, time: new Date().toISOString() };
    console.log(`[COMMAND] WiFi change queued → SSID: ${ssid}`);
    return res.json({ ok: true, queued: "wifi_change", ssid });
  }

  pendingCommand = { action, time: new Date().toISOString() };
  console.log(`[COMMAND] Queued: ${action}`);
  res.json({ ok: true, queued: action });
});

// ─────────────────────────────────────────────
// GET /pending — ESP32 polls for commands
// ─────────────────────────────────────────────
app.get("/pending", (req, res) => {
  const cmd  = pendingCommand;
  pendingCommand = null;
  res.json({ command: cmd });
});

// ─────────────────────────────────────────────
// GET /remote-data
// ─────────────────────────────────────────────
app.get("/remote-data", (req, res) => res.json(latestData));

// ─────────────────────────────────────────────
// GET /incidents
// ─────────────────────────────────────────────
app.get("/incidents", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_INCIDENTS);
  res.json({ count: incidentLog.length, incidents: incidentLog.slice(0, limit) });
});

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  ok: true, uptime: process.uptime(),
  pending: pendingCommand, lastSeen: latestData.timestamp
}));

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Dashboard connected: ${socket.id}`);
  socket.emit("sensorUpdate", latestData);
  socket.on("disconnect", () => console.log(`[WS] Disconnected: ${socket.id}`));
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
  console.log(`[SERVER] Dashboard: http://localhost:${PORT}/main.html`);
  sendTelegram(`✅ <b>Gas Safety Server Started!</b>\n🌐 System is online and monitoring.\n🕐 ${new Date().toLocaleTimeString()}`);
});
