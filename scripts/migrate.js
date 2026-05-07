'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sqlDir = path.join(__dirname, '..', 'sql');
  const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await pool.query(sql);
  }

  await pool.end();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
