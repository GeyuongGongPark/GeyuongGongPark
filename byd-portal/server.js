const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ─── Slack / Friday 연동 ──────────────────────────────────────────────────────
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID   = process.env.SLACK_CHANNEL_ID;
const SLACK_FRIDAY_USER_ID = process.env.SLACK_FRIDAY_USER_ID;

const APP_REPO_MAP = {
  'BYD AutoLock':         'BydAutoLock-iOS',
  'BYD Watch':            'BYD_Watch',
  'BYD HomeKit':          'BYD-Apple-Homekit',
  'BYD Launcher':         'BYDLauncher',
  'BYD Status':           'BYDstatus',
  'BYD Camera Recorder':  'BYDCameraRecorder',
  'BYD Health Monitor':   'BYD-Health-Monitor',
};

async function notifyFriday(report) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID || !SLACK_FRIDAY_USER_ID) return;

  const repo = APP_REPO_MAP[report.app];
  if (!repo) return;

  const lines = [
    `<@${SLACK_FRIDAY_USER_ID}> [repo:${repo}] 신규 제보 #${report.id}: ${report.title}`,
    `> 앱: ${report.app}`,
    report.platform ? `> 플랫폼: ${report.platform}` : null,
    `> 차종: ${report.car}`,
    `> 내용: ${report.body.slice(0, 500)}`,
  ].filter(Boolean).join('\n');

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text: lines }),
  }).catch(e => console.error('[friday] Slack 알림 실패:', e.message));
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id        SERIAL PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      body      TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 필요' });
  }
  try {
    jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '토큰 만료 또는 유효하지 않음' });
  }
}

// API — 관리자 로그인
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// API — 제보 목록 (댓글 포함)
app.get('/api/reports', async (req, res) => {
  try {
    const { app: appFilter } = req.query;
    const values = appFilter ? [appFilter] : [];
    const where = appFilter ? 'WHERE r.app = $1' : '';
    const { rows } = await pool.query(`
      SELECT r.*,
        COALESCE(
          json_agg(c ORDER BY c.created_at ASC) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) AS comments
      FROM reports r
      LEFT JOIN comments c ON c.report_id = r.id
      ${where}
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// API — 제보 저장
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
    const report = { ...rows[0], comments: [] };
    res.status(201).json(report);
    notifyFriday(report); // 비동기 — 응답 지연 없음
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// API — 댓글 저장 (관리자 전용)
app.post('/api/reports/:id/comments', verifyAdmin, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { body } = req.body;
    if (!body || !body.trim()) {
      return res.status(400).json({ error: '내용을 입력해주세요' });
    }
    const { rows } = await pool.query(
      `INSERT INTO comments (report_id, body) VALUES ($1, $2) RETURNING *`,
      [reportId, body.trim()]
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
