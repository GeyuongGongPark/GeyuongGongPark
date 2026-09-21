const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id        SERIAL PRIMARY KEY,
      title     TEXT NOT NULL,
      app       TEXT NOT NULL,
      platform  TEXT,
      car       TEXT NOT NULL,
      body      TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      file_data TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API
app.get('/api/reports', async (req, res) => {
  try {
    const { app: appFilter } = req.query;
    const query = appFilter
      ? { text: 'SELECT * FROM reports WHERE app = $1 ORDER BY created_at DESC', values: [appFilter] }
      : { text: 'SELECT * FROM reports ORDER BY created_at DESC' };
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

app.post('/api/reports', async (req, res) => {
  try {
    const { title, app, platform, car, body, file_name, file_type, file_data } = req.body;
    if (!title || !app || !car || !body) {
      return res.status(400).json({ error: '필수 항목 누락' });
    }
    const { rows } = await pool.query(
      `INSERT INTO reports (title, app, platform, car, body, file_name, file_type, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [title, app, platform || null, car, body, file_name || null, file_type || null, file_data || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`BYD Portal running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed', err); process.exit(1); });
