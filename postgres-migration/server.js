// ============================================================
// CCB Tools -- Postgres migration staging service.
// This is intentionally minimal right now: it exists to prove
// the database is reachable and the migrated data looks right
// before any real app logic gets rebuilt on top of it. The full
// endpoint-by-endpoint rewrite of server.js (Quotes, Orders,
// Production, Rep Dashboard, etc.) is the next phase.
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'CCB Tools staging service (Postgres) is running.' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// One-time schema setup -- safe to call repeatedly (CREATE TABLE IF NOT EXISTS
// would be even safer, but schema.sql is written to run clean on an empty DB;
// this endpoint just runs it).
app.post('/api/admin/init-schema', async (req, res) => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    res.json({ ok: true, message: 'Schema created.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, hint: 'If tables already exist, this will fail on the second run -- that is expected, not a problem.' });
  }
});

// Row counts across every table -- the fastest way to sanity-check that the
// migration actually pulled everything, without needing direct DB access.
app.get('/api/admin/row-counts', async (req, res) => {
  const tables = ['reps', 'orders', 'order_products', 'quotes', 'quote_line_items', 'client_notes', 'production_time_logs', 'damaged_goods', 'rep_tasks', 'inventory', 'gift_boxes'];
  try {
    const counts = {};
    for (const t of tables) {
      const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
      counts[t] = parseInt(r.rows[0].count, 10);
    }
    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Spot-check a handful of real rows from any table, for eyeballing correctness.
app.get('/api/admin/sample/:table', async (req, res) => {
  const allowedTables = ['reps', 'orders', 'order_products', 'quotes', 'quote_line_items', 'client_notes', 'production_time_logs', 'damaged_goods', 'rep_tasks', 'inventory', 'gift_boxes'];
  const table = req.params.table;
  if (!allowedTables.includes(table)) return res.status(400).json({ error: 'Unknown table' });
  try {
    const r = await pool.query(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 10`);
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CCB Tools staging (Postgres) server running on port ${PORT}`);
});
