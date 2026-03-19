// const express = require("express");
// const router = express.Router();
// const pool = require("../../database/db");
// const { broadcast } = require("../activityBroadcaster");

// // ─── Helper: log to activity_log ──────────────────────────────────────────────
// // clinic_id is now required (NOT NULL in schema)
// async function logActivity(clinic_id, event_type, title, meta = null) {
//   try {
//     const { rows } = await pool.query(
//       `INSERT INTO activity_log (clinic_id, event_type, title, meta)
//        VALUES ($1, $2, $3, $4) RETURNING *`,
//       [clinic_id, event_type, title, meta]
//     );
//     broadcast({ type: "activity", data: rows[0] });
//   } catch (_) {} // never crash the main request
// }

// // ─── GET /api/appointments/schedule?date=YYYY-MM-DD&doctor_id=&status= ────────
// // Schema change: appointment_date + start_time → appointment_start TIMESTAMPTZ
// // We filter by DATE(appointment_start AT TIME ZONE clinic.timezone)
// router.get("/schedule", async (req, res) => {
//   try {
//     const { date, doctor_id, status, clinic_id } = req.query;
//     const targetDate = date || new Date().toISOString().split("T")[0];

//     if (!clinic_id) {
//       return res.status(400).json({ success: false, error: "clinic_id query param required" });
//     }

//     let query = `
//       SELECT
//         a.id,
//         a.appointment_start,
//         a.appointment_end,
//         a.reason,
//         a.notes,
//         a.status,
//         a.payment_status,
//         a.payment_amount,
//         a.source,
//         a.created_at,
//         p.id   AS patient_id,
//         p.name AS patient_name,
//         p.phone AS patient_phone,
//         d.id   AS doctor_id,
//         d.name AS doctor_name,
//         d.speciality AS doctor_speciality
//       FROM appointments a
//       JOIN patients p ON a.patient_id = p.id
//       JOIN doctors  d ON a.doctor_id  = d.id
//       WHERE a.clinic_id = $1
//         AND a.deleted_at IS NULL
//         AND DATE(a.appointment_start AT TIME ZONE 'Asia/Kolkata') = $2
//     `;

//     const params = [clinic_id, targetDate];
//     let paramIdx = 3;

//     if (doctor_id) {
//       query += ` AND a.doctor_id = $${paramIdx++}`;
//       params.push(doctor_id);
//     }

//     if (status) {
//       query += ` AND a.status = $${paramIdx++}`;
//       params.push(status);
//     }

//     query += ` ORDER BY a.appointment_start ASC`;

//     const result = await pool.query(query, params);
//     res.json({ success: true, data: result.rows, date: targetDate });
//   } catch (err) {
//     console.error("Schedule fetch error:", err);
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// // ─── GET /api/appointments/stats?date=YYYY-MM-DD&clinic_id= ──────────────────
// // Schema change: no 'booked' status → use 'confirmed' | 'pending'
// // appointment_date → DATE(appointment_start AT TIME ZONE tz)
// router.get("/stats", async (req, res) => {
//   try {
//     const { date, clinic_id } = req.query;
//     const targetDate = date || new Date().toISOString().split("T")[0];

//     if (!clinic_id) {
//       return res.status(400).json({ success: false, error: "clinic_id query param required" });
//     }

//     const statsQuery = `
//       SELECT
//         COUNT(*)                                                                          AS total,
//         COUNT(*) FILTER (WHERE status = 'pending')                                        AS pending,
//         COUNT(*) FILTER (WHERE status = 'confirmed')                                      AS confirmed,
//         COUNT(*) FILTER (WHERE status = 'completed')                                      AS completed,
//         COUNT(*) FILTER (WHERE status = 'cancelled')                                      AS cancelled,
//         COUNT(*) FILTER (WHERE status = 'no_show')                                        AS no_show,
//         COUNT(*) FILTER (WHERE status = 'rescheduled')                                    AS rescheduled,
//         COUNT(*) FILTER (
//           WHERE created_at::date = CURRENT_DATE
//             AND created_at > NOW() - INTERVAL '1 hour'
//         )                                                                                 AS booked_last_hour
//       FROM appointments
//       WHERE clinic_id = $1
//         AND deleted_at IS NULL
//         AND DATE(appointment_start AT TIME ZONE 'Asia/Kolkata') = $2
//     `;

//     const result = await pool.query(statsQuery, [clinic_id, targetDate]);
//     res.json({ success: true, data: result.rows[0], date: targetDate });
//   } catch (err) {
//     console.error("Stats fetch error:", err);
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// // ─── GET /api/appointments/:id ────────────────────────────────────────────────
// router.get("/:id", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const result = await pool.query(
//       `SELECT
//          a.*,
//          p.name    AS patient_name,
//          p.phone   AS patient_phone,
//          d.name    AS doctor_name,
//          d.speciality
//        FROM appointments a
//        JOIN patients p ON a.patient_id = p.id
//        JOIN doctors  d ON a.doctor_id  = d.id
//        WHERE a.id = $1
//          AND a.deleted_at IS NULL`,
//       [id]
//     );
//     if (result.rows.length === 0) {
//       return res.status(404).json({ success: false, error: "Appointment not found" });
//     }
//     res.json({ success: true, data: result.rows[0] });
//   } catch (err) {
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// // ─── POST /api/appointments — book new appointment ────────────────────────────
// // Schema changes:
// //   • patients UNIQUE(clinic_id, phone) — conflict target must include clinic_id
// //   • appointments uses appointment_start / appointment_end (TIMESTAMPTZ), not date+time cols
// //   • default status is 'confirmed' (no 'booked' in enum)
// //   • doctor_time_off uses TIMESTAMPTZ range, not a date + time columns
// //   • clinic_id required everywhere
// router.post("/", async (req, res) => {
//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");

//     const {
//       clinic_id,
//       patient_name,
//       patient_phone,
//       doctor_id,
//       appointment_start,  // ISO string, e.g. "2025-03-15T09:00:00+05:30"
//       appointment_end,
//       reason,
//       source = "manual",
//       created_by = null,
//     } = req.body;

//     if (!clinic_id || !patient_name || !patient_phone || !doctor_id || !appointment_start || !appointment_end) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({
//         success: false,
//         error: "clinic_id, patient_name, patient_phone, doctor_id, appointment_start, appointment_end are required",
//       });
//     }

//     // Upsert patient — conflict on (clinic_id, phone) per schema UNIQUE constraint
//     const patientResult = await client.query(
//       `INSERT INTO patients (clinic_id, name, phone)
//        VALUES ($1, $2, $3)
//        ON CONFLICT (clinic_id, phone) DO UPDATE SET name = EXCLUDED.name
//        RETURNING id`,
//       [clinic_id, patient_name, patient_phone]
//     );
//     const patient_id = patientResult.rows[0].id;

//     // Check for slot conflicts — schema has UNIQUE(doctor_id, appointment_start)
//     const conflict = await client.query(
//       `SELECT id FROM appointments
//        WHERE doctor_id = $1
//          AND appointment_start = $2
//          AND status NOT IN ('cancelled', 'rescheduled')
//          AND deleted_at IS NULL
//        FOR UPDATE`,
//       [doctor_id, appointment_start]
//     );

//     if (conflict.rows.length > 0) {
//       await client.query("ROLLBACK");
//       return res.status(409).json({ success: false, error: "This time slot is already booked." });
//     }

//     // Check doctor time off — doctor_time_off uses TIMESTAMPTZ ranges (no separate date col)
//     const timeOff = await client.query(
//       `SELECT id FROM doctor_time_off
//        WHERE doctor_id = $1
//          AND start_time <= $2
//          AND end_time   >= $3`,
//       [doctor_id, appointment_start, appointment_end]
//     );

//     if (timeOff.rows.length > 0) {
//       await client.query("ROLLBACK");
//       return res.status(409).json({ success: false, error: "Doctor is on leave during this time." });
//     }

//     // Insert appointment — status 'confirmed' (no 'booked' in enum)
//     const apptResult = await client.query(
//       `INSERT INTO appointments
//          (clinic_id, patient_id, doctor_id, appointment_start, appointment_end, reason, status, source, created_by)
//        VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8)
//        RETURNING *`,
//       [clinic_id, patient_id, doctor_id, appointment_start, appointment_end, reason, source, created_by]
//     );

//     await client.query("COMMIT");

//     // Log activity — clinic_id now required
//     const doctorResult = await pool.query(`SELECT name FROM doctors WHERE id = $1`, [doctor_id]);
//     const doctorName = doctorResult.rows[0]?.name || "Unknown Doctor";
//     await logActivity(
//       clinic_id,
//       "manual_booking",
//       `Receptionist booked ${patient_name} with ${doctorName}`,
//       `${appointment_start}`
//     );

//     res.status(201).json({ success: true, data: apptResult.rows[0] });
//   } catch (err) {
//     await client.query("ROLLBACK");
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     client.release();
//   }
// });

// // ─── PATCH /api/appointments/:id/status ───────────────────────────────────────
// // Schema enum: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show' | 'rescheduled'
// // Removed 'booked' — it does not exist in the schema
// router.patch("/:id/status", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { status, cancelled_by = null } = req.body;

//     const allowed = ["pending", "confirmed", "cancelled", "completed", "no_show", "rescheduled"];
//     if (!allowed.includes(status)) {
//       return res.status(400).json({ success: false, error: `Invalid status. Allowed: ${allowed.join(", ")}` });
//     }

//     // Persist cancelled_by when cancelling
//     const result = await pool.query(
//       `UPDATE appointments
//        SET status       = $1,
//            cancelled_by = CASE WHEN $1 = 'cancelled' THEN $3::UUID ELSE cancelled_by END,
//            updated_at   = NOW()
//        WHERE id = $2
//          AND deleted_at IS NULL
//        RETURNING *`,
//       [status, id, cancelled_by]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({ success: false, error: "Appointment not found" });
//     }

//     const appt = result.rows[0];

//     // Fetch names for the activity log
//     const detailResult = await pool.query(
//       `SELECT p.name AS patient_name, d.name AS doctor_name
//        FROM appointments a
//        JOIN patients p ON a.patient_id = p.id
//        JOIN doctors  d ON a.doctor_id  = d.id
//        WHERE a.id = $1`,
//       [id]
//     );
//     const detail = detailResult.rows[0];

//     const activityMap = {
//       completed:   { type: "manual_booking", label: "marked completed" },
//       cancelled:   { type: "cancellation",   label: "cancelled"        },
//       no_show:     { type: "cancellation",   label: "marked no-show"   },
//       rescheduled: { type: "reschedule",     label: "rescheduled"      },
//     };

//     if (detail && activityMap[status]) {
//       const { type, label } = activityMap[status];
//       await logActivity(
//         appt.clinic_id,
//         type,
//         `Receptionist ${label} appointment for ${detail.patient_name}`,
//         `With ${detail.doctor_name} on ${appt.appointment_start}`
//       );
//     }

//     res.json({ success: true, data: appt });
//   } catch (err) {
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// // ─── DELETE /api/appointments/:id (soft cancel) ───────────────────────────────
// router.delete("/:id", async (req, res) => {
//   try {
//     const result = await pool.query(
//       `UPDATE appointments
//        SET status     = 'cancelled',
//            updated_at = NOW()
//        WHERE id = $1
//          AND deleted_at IS NULL
//        RETURNING *`,
//       [req.params.id]
//     );
//     if (result.rows.length === 0) {
//       return res.status(404).json({ success: false, error: "Appointment not found" });
//     }
//     res.json({ success: true, data: result.rows[0] });
//   } catch (err) {
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// module.exports = router;


const express = require("express");
const router = express.Router();
const pool = require("../../database/db");
const { broadcast } = require("../activityBroadcaster");

// ─── Helper: log to activity_log ──────────────────────────────────────────────
async function logActivity(clinic_id, event_type, title, meta = null) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO activity_log (clinic_id, event_type, title, meta)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [clinic_id, event_type, title, meta]
    );
    broadcast({ type: "activity", data: rows[0] });
  } catch (_) {} // never crash the main request
}

// ─── GET /api/appointments/schedule?date=YYYY-MM-DD&doctor_id=&status= ────────
router.get("/schedule", async (req, res) => {
  try {
    const { date, doctor_id, status, clinic_id } = req.query;
    const targetDate = date || new Date().toISOString().split("T")[0];

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    let query = `
      SELECT
        a.id,
        a.appointment_start,
        a.appointment_end,
        a.reason,
        a.notes,
        a.status,
        a.payment_status,
        a.payment_amount,
        a.source,
        a.created_at,
        p.id   AS patient_id,
        p.name AS patient_name,
        p.phone AS patient_phone,
        d.id   AS doctor_id,
        d.name AS doctor_name,
        d.speciality AS doctor_speciality
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      JOIN doctors  d ON a.doctor_id  = d.id
      WHERE a.clinic_id = $1
        AND a.deleted_at IS NULL
        AND DATE(a.appointment_start AT TIME ZONE 'Asia/Kolkata') = $2
    `;

    const params = [clinic_id, targetDate];
    let paramIdx = 3;

    if (doctor_id) {
      query += ` AND a.doctor_id = $${paramIdx++}`;
      params.push(doctor_id);
    }

    if (status) {
      query += ` AND a.status = $${paramIdx++}`;
      params.push(status);
    }

    query += ` ORDER BY a.appointment_start ASC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows, date: targetDate });
  } catch (err) {
    console.error("Schedule fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/appointments/stats?date=YYYY-MM-DD&clinic_id= ──────────────────
router.get("/stats", async (req, res) => {
  try {
    const { date, clinic_id } = req.query;
    const targetDate = date || new Date().toISOString().split("T")[0];

    if (!clinic_id) {
      return res.status(400).json({ success: false, error: "clinic_id query param required" });
    }

    const statsQuery = `
      SELECT
        COUNT(*)                                                                          AS total,
        COUNT(*) FILTER (WHERE status = 'pending')                                        AS pending,
        COUNT(*) FILTER (WHERE status = 'confirmed')                                      AS confirmed,
        COUNT(*) FILTER (WHERE status = 'completed')                                      AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')                                      AS cancelled,
        COUNT(*) FILTER (WHERE status = 'no_show')                                        AS no_show,
        COUNT(*) FILTER (WHERE status = 'rescheduled')                                    AS rescheduled,
        COUNT(*) FILTER (
          WHERE created_at::date = CURRENT_DATE
            AND created_at > NOW() - INTERVAL '1 hour'
        )                                                                                 AS booked_last_hour
      FROM appointments
      WHERE clinic_id = $1
        AND deleted_at IS NULL
        AND DATE(appointment_start AT TIME ZONE 'Asia/Kolkata') = $2
    `;

    const result = await pool.query(statsQuery, [clinic_id, targetDate]);
    res.json({ success: true, data: result.rows[0], date: targetDate });
  } catch (err) {
    console.error("Stats fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/appointments/:id ────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
         a.*,
         p.name    AS patient_name,
         p.phone   AS patient_phone,
         d.name    AS doctor_name,
         d.speciality
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       JOIN doctors  d ON a.doctor_id  = d.id
       WHERE a.id = $1
         AND a.deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Appointment not found" });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/appointments — book new appointment ────────────────────────────
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      clinic_id,
      patient_name,
      patient_phone,
      doctor_id,
      appointment_start,
      appointment_end,
      reason,
      source = "manual",
      created_by = null,
    } = req.body;

    if (!clinic_id || !patient_name || !patient_phone || !doctor_id || !appointment_start || !appointment_end) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: "clinic_id, patient_name, patient_phone, doctor_id, appointment_start, appointment_end are required",
      });
    }

    const patientResult = await client.query(
      `INSERT INTO patients (clinic_id, name, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (clinic_id, phone) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [clinic_id, patient_name, patient_phone]
    );
    const patient_id = patientResult.rows[0].id;

    const conflict = await client.query(
      `SELECT id FROM appointments
       WHERE doctor_id = $1
         AND appointment_start = $2
         AND status NOT IN ('cancelled', 'rescheduled')
         AND deleted_at IS NULL
       FOR UPDATE`,
      [doctor_id, appointment_start]
    );

    if (conflict.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "This time slot is already booked." });
    }

    const timeOff = await client.query(
      `SELECT id FROM doctor_time_off
       WHERE doctor_id = $1
         AND start_time <= $2
         AND end_time   >= $3`,
      [doctor_id, appointment_start, appointment_end]
    );

    if (timeOff.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "Doctor is on leave during this time." });
    }

    const apptResult = await client.query(
      `INSERT INTO appointments
         (clinic_id, patient_id, doctor_id, appointment_start, appointment_end, reason, status, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8)
       RETURNING *`,
      [clinic_id, patient_id, doctor_id, appointment_start, appointment_end, reason, source, created_by]
    );

    await client.query("COMMIT");

    const doctorResult = await pool.query(`SELECT name FROM doctors WHERE id = $1`, [doctor_id]);
    const doctorName = doctorResult.rows[0]?.name || "Unknown Doctor";
    await logActivity(
      clinic_id,
      "manual_booking",
      `Receptionist booked ${patient_name} with ${doctorName}`,
      `${appointment_start}`
    );

    res.status(201).json({ success: true, data: apptResult.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/appointments/:id/status ───────────────────────────────────────
//
// THE BUG THAT WAS HERE:
//   The original query reused $1 in two different type contexts:
//     SET status = $1                            ← Postgres infers: appointment_status enum
//     CASE WHEN $1 = 'cancelled' THEN $3::UUID   ← Postgres infers: text
//   Postgres cannot reconcile enum vs text for the same parameter → 500 error.
//
// THE FIX:
//   Split into two separate queries:
//     1. Always UPDATE status + updated_at (no type ambiguity).
//     2. If status === 'cancelled' AND cancelled_by is provided, UPDATE cancelled_by separately.
//   This completely eliminates the ambiguous parameter type problem.
//
router.patch("/:id/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, cancelled_by = null } = req.body;

    const allowed = ["pending", "confirmed", "cancelled", "completed", "no_show", "rescheduled"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Allowed: ${allowed.join(", ")}`,
      });
    }

    await client.query("BEGIN");

    // ── Step 1: update status (single unambiguous parameter type) ─────────────
    const result = await client.query(
      `UPDATE appointments
       SET status     = $1,
           updated_at = NOW()
       WHERE id         = $2
         AND deleted_at IS NULL
       RETURNING *`,
      [status, id]   // $1 = text → cast to enum by Postgres without ambiguity
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Appointment not found" });
    }

    // ── Step 2: set cancelled_by only when relevant ───────────────────────────
    // Kept as a separate query so $1 is never used in two type contexts at once.
    if (status === "cancelled" && cancelled_by) {
      await client.query(
        `UPDATE appointments
         SET cancelled_by = $1::UUID
         WHERE id = $2`,
        [cancelled_by, id]
      );
    }

    await client.query("COMMIT");

    const appt = result.rows[0];

    // ── Fetch names for the activity log (outside the transaction) ─────────────
    const detailResult = await pool.query(
      `SELECT p.name AS patient_name, d.name AS doctor_name
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       JOIN doctors  d ON a.doctor_id  = d.id
       WHERE a.id = $1`,
      [id]
    );
    const detail = detailResult.rows[0];

    const activityMap = {
      completed:   { type: "manual_booking", label: "marked completed" },
      cancelled:   { type: "cancellation",   label: "cancelled"        },
      no_show:     { type: "cancellation",   label: "marked no-show"   },
      rescheduled: { type: "reschedule",     label: "rescheduled"      },
    };

    if (detail && activityMap[status]) {
      const { type, label } = activityMap[status];
      await logActivity(
        appt.clinic_id,
        type,
        `Receptionist ${label} appointment for ${detail.patient_name}`,
        `With ${detail.doctor_name} on ${appt.appointment_start}`
      );
    }

    res.json({ success: true, data: appt });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Status update error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/appointments/:id (soft cancel) ───────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE appointments
       SET status     = 'cancelled',
           updated_at = NOW()
       WHERE id = $1
         AND deleted_at IS NULL
       RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Appointment not found" });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;