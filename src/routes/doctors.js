const express = require("express");
const router = express.Router();
const pool = require("../../database/db");

// ─── GET /api/doctors?clinic_id= — list all active doctors for a clinic ───────
router.get("/", async (req, res) => {
  try {
    const { clinic_id } = req.query;

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    const result = await pool.query(
      `SELECT * FROM doctors
       WHERE clinic_id = $1
         AND is_active  = true
         AND deleted_at IS NULL
       ORDER BY name ASC`,
      [clinic_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/doctors/:id/slots?date=YYYY-MM-DD&clinic_id= ───────────────────
// Schema changes:
//   • doctor_time_off uses TIMESTAMPTZ ranges — no separate `date` column
//   • appointments uses appointment_start TIMESTAMPTZ — no appointment_date + start_time cols
//   • doctor_schedule.effective_from / effective_to now respected
router.get("/:id/slots", async (req, res) => {
  try {
    const { id } = req.params;
    const { date, clinic_id } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, error: "date query param required" });
    }
    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    // new Date(date) parses YYYY-MM-DD as UTC midnight; getUTCDay() avoids DST shift
    const dayOfWeek = new Date(date).getUTCDay(); // 0=Sun, 6=Sat

    // Get doctor schedule for this weekday, honouring effective date window
    const scheduleResult = await pool.query(
      `SELECT * FROM doctor_schedule
       WHERE doctor_id   = $1
         AND clinic_id   = $2
         AND day_of_week = $3
         AND effective_from <= $4::date
         AND (effective_to IS NULL OR effective_to >= $4::date)
       LIMIT 1`,
      [id, clinic_id, dayOfWeek, date]
    );

    if (scheduleResult.rows.length === 0) {
      return res.json({ success: true, data: [], message: "Doctor does not work this day" });
    }

    const schedule = scheduleResult.rows[0];
    const slotDuration = schedule.slot_duration_minutes;

    // ── Booked slots ─────────────────────────────────────────────────────────
    // appointment_start is TIMESTAMPTZ; extract the HH:MM:SS in IST for comparison
    const bookedResult = await pool.query(
      `SELECT TO_CHAR(appointment_start AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS start_time
       FROM appointments
       WHERE doctor_id  = $1
         AND clinic_id  = $2
         AND deleted_at IS NULL
         AND status NOT IN ('cancelled', 'rescheduled')
         AND DATE(appointment_start AT TIME ZONE 'Asia/Kolkata') = $3::date`,
      [id, clinic_id, date]
    );
    const bookedTimes = new Set(bookedResult.rows.map((r) => r.start_time));

    // ── Doctor time-off for this date ─────────────────────────────────────────
    // doctor_time_off has no `date` column — filter by TIMESTAMPTZ overlap with the target day
    const dayStart = `${date}T00:00:00+05:30`;
    const dayEnd   = `${date}T23:59:59+05:30`;

    const timeOffResult = await pool.query(
      `SELECT
         TO_CHAR(start_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS off_start,
         TO_CHAR(end_time   AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS off_end
       FROM doctor_time_off
       WHERE doctor_id  = $1
         AND clinic_id  = $2
         AND start_time < $4::timestamptz
         AND end_time   > $3::timestamptz`,
      [id, clinic_id, dayStart, dayEnd]
    );

    // ── Generate slots ────────────────────────────────────────────────────────
    const slots = [];
    const [startH, startM] = schedule.start_time.split(":").map(Number);
    const [endH,   endM  ] = schedule.end_time.split(":").map(Number);
    let current    = startH * 60 + startM;
    const endMins  = endH   * 60 + endM;

    while (current + slotDuration <= endMins) {
      const hh      = String(Math.floor(current / 60)).padStart(2, "0");
      const mm      = String(current % 60).padStart(2, "0");
      const timeStr = `${hh}:${mm}:00`;

      const isBooked   = bookedTimes.has(timeStr);
      const isOnLeave  = timeOffResult.rows.some(
        (to) => timeStr >= to.off_start && timeStr < to.off_end
      );

      slots.push({ time: timeStr, available: !isBooked && !isOnLeave });
      current += slotDuration;
    }

    res.json({ success: true, data: slots });
  } catch (err) {
    console.error("Slots fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;