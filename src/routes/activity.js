// server/src/routes/activity.js
const express  = require("express");
const router   = express.Router();
const pool     = require("../../database/db");
const { broadcast } = require("../activityBroadcaster");

// ─── GET /api/activity?clinic_id=&limit=20 ────────────────────────────────────
// Schema change: clinic_id is NOT NULL on activity_log — always filter by it
router.get("/", async (req, res) => {
  try {
    const { clinic_id, limit } = req.query;

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    const safeLimit = Math.min(parseInt(limit) || 20, 100);

    const { rows } = await pool.query(
      `SELECT id, event_type, title, entity_type, entity_id, user_id, meta, created_at
       FROM activity_log
       WHERE clinic_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [clinic_id, safeLimit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/activity ───────────────────────────────────────────────────────
// clinic_id required; schema also supports entity_type, entity_id, user_id
router.post("/", async (req, res) => {
  const { clinic_id, event_type, title, entity_type, entity_id, user_id, meta } = req.body;

  if (!clinic_id || !event_type || !title) {
    return res.status(400).json({
      success: false,
      error: "clinic_id, event_type, and title are required",
    });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO activity_log (clinic_id, event_type, title, entity_type, entity_id, user_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [clinic_id, event_type, title, entity_type || null, entity_id || null, user_id || null, meta || null]
    );
    broadcast({ type: "activity", data: rows[0] });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;