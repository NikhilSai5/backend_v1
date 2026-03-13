require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  ssl: process.env.DB_SSL === "true"
    ? { rejectUnauthorized: false }  // RDS requires SSL
    : false,
  max:              10,   // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ Connected to RDS PostgreSQL");
    release();
  }
});

module.exports = pool;