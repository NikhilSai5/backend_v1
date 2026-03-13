require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('./db');

const migrationsDir = path.join(__dirname, 'migrations');

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const alreadyRun = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1',
        [filename]
      );

      if (alreadyRun.rowCount > 0) {
        console.log(`Skipping ${filename} (already applied)`);
        continue;
      }

      const fullPath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(fullPath, 'utf8');

      console.log(`Applying ${filename}...`);
      await client.query(sql);

      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
      );

      console.log(`Applied ${filename}`);
    }

    await client.query('COMMIT');
    console.log('Database migrations complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
