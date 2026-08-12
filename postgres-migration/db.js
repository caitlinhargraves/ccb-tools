const { Pool } = require('pg');

// Render wires DATABASE_URL automatically once the Postgres instance from
// render.yaml is provisioned and linked to this service's environment.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
