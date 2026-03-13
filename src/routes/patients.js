// server/src/routes/patients.js
const express = require("express");
const router = express.Router();
const pool = require("../../database/db");

// ─── GET /api/patients?clinic_id=&search=name_or_phone&limit=10 ───────────────
// Schema changes:
//   • patients are scoped to a clinic — clinic_id filter required
//   • appointments.appointment_date removed → use DATE(appointment_start AT TIME ZONE tz)
router.get("/", async (req, res) => {
  try {
    const { clinic_id, search, limit = 10 } = req.query;

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    let query = `
      SELECT
        p.id,
        p.name,
        p.phone,
        p.email,
        p.gender,
        p.date_of_birth,
        p.created_at,
        COUNT(a.id)                                                               AS total_appointments,
        MAX(DATE(a.appointment_start AT TIME ZONE 'Asia/Kolkata'))                AS last_visit
      FROM patients p
      LEFT JOIN appointments a
             ON a.patient_id = p.id
            AND a.deleted_at IS NULL
      WHERE p.clinic_id = $1
        AND p.deleted_at IS NULL
    `;

    const params = [clinic_id];

    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }

    params.push(Number(limit));
    query += ` GROUP BY p.id ORDER BY p.name ASC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Patients fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/patients/:id?clinic_id= — single patient with appointment history
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { clinic_id } = req.query;

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    const patientResult = await pool.query(
      `SELECT
         p.*,
         COUNT(a.id)                                                              AS total_appointments,
         MAX(DATE(a.appointment_start AT TIME ZONE 'Asia/Kolkata'))               AS last_visit
       FROM patients p
       LEFT JOIN appointments a
              ON a.patient_id = p.id
             AND a.deleted_at IS NULL
       WHERE p.id        = $1
         AND p.clinic_id = $2
         AND p.deleted_at IS NULL
       GROUP BY p.id`,
      [id, clinic_id]
    );

    if (patientResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Patient not found" });
    }

    // Appointment history — use appointment_start for ordering (no appointment_date col)
    const historyResult = await pool.query(
      `SELECT
         a.id,
         a.appointment_start,
         a.appointment_end,
         a.reason,
         a.notes,
         a.status,
         a.payment_status,
         a.payment_amount,
         a.source,
         d.name       AS doctor_name,
         d.speciality AS doctor_speciality
       FROM appointments a
       JOIN doctors d ON a.doctor_id = d.id
       WHERE a.patient_id = $1
         AND a.clinic_id  = $2
         AND a.deleted_at IS NULL
       ORDER BY a.appointment_start DESC
       LIMIT 20`,
      [id, clinic_id]
    );

    res.json({
      success: true,
      data: {
        ...patientResult.rows[0],
        history: historyResult.rows,
      },
    });
  } catch (err) {
    console.error("Patient detail fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;