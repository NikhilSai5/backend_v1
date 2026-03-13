// server/src/index.js
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const http       = require("http");
const WebSocket  = require("ws");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { registerClient } = require("./activityBroadcaster");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: "/ws/activity" });

const PORT = process.env.PORT || 4002;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── WebSocket connection handler ──────────────────────────────────────────────
wss.on("connection", (ws) => {
  console.log(`[WS] Client connected (${wss.clients.size} total)`);
  registerClient(ws);

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("close", () => {
    clearInterval(ping);
    console.log(`[WS] Client disconnected (${wss.clients.size} remaining)`);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/appointments", require("./routes/appointments"));
app.use("/api/doctors",      require("./routes/doctors"));
app.use("/api/patients",     require("./routes/patients"));
app.use("/api/activity",     require("./routes/activity"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const pool = require("../../database/db");
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected", time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "error", db: "disconnected", error: err.message });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.url}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: err.message || "Internal server error" });
});

// ── Start — use server.listen (not app.listen) so WebSocket shares the port ───
server.listen(PORT, () => {
  const today = new Date().toISOString().split("T")[0];
  console.log(`\n🚀 Server → http://localhost:${PORT}`);
  console.log(`   WebSocket → ws://localhost:${PORT}/ws/activity`);
  console.log(`   Health    → http://localhost:${PORT}/api/health`);
  console.log(`   Schedule  → http://localhost:${PORT}/api/appointments/schedule?clinic_id=<id>&date=${today}`);
  console.log(`   Doctors   → http://localhost:${PORT}/api/doctors?clinic_id=<id>`);
  console.log(`   Patients  → http://localhost:${PORT}/api/patients?clinic_id=<id>\n`);
});