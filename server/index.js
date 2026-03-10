require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'watchdog-fallback-secret-change-in-production';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ─── PERSISTENCE (SQLite) ─────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const DATA_DIR  = path.join(__dirname, '../data');
const DB_PATH   = path.join(DATA_DIR, 'watchdog.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate existing DB if email column not yet present
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN role              TEXT    NOT NULL DEFAULT \'user\''); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN disabled          INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN trackerLimit      INTEGER'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN notificationsEnabled INTEGER NOT NULL DEFAULT 1'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt    TEXT NOT NULL,
    email        TEXT,
    role         TEXT NOT NULL DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS trackers (
    id            TEXT PRIMARY KEY,
    userId        TEXT NOT NULL REFERENCES users(id),
    label         TEXT,
    url           TEXT,
    interval      INTEGER DEFAULT 30000,
    active        INTEGER DEFAULT 1,
    status        TEXT    DEFAULT 'pending',
    lastCheck     TEXT,
    lastHash      TEXT,
    lastBody      TEXT,
    httpStatus    INTEGER,
    changeCount   INTEGER DEFAULT 0,
    changeSummary TEXT,
    changeSnippet TEXT,
    error         TEXT,
    aiSummary     INTEGER DEFAULT 0,
    createdAt     TEXT,
    position      INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS changes (
    id           TEXT PRIMARY KEY,
    trackerId    TEXT NOT NULL,
    trackerLabel TEXT,
    url          TEXT,
    detectedAt   TEXT,
    summary      TEXT,
    oldHash      TEXT,
    newHash      TEXT
  );
`);

function rowToTracker(row) {
  return {
    ...row,
    active:       row.active    === 1,
    aiSummary:    row.aiSummary !== 0,
    changeSnippet: row.changeSnippet ? JSON.parse(row.changeSnippet) : null,
  };
}

function loadTrackers() {
  return db.prepare('SELECT * FROM trackers ORDER BY position ASC').all().map(rowToTracker);
}

function loadChanges() {
  return db.prepare('SELECT * FROM changes ORDER BY detectedAt DESC').all();
}

function loadUsers() {
  return db.prepare('SELECT * FROM users').all();
}

function saveUsers(users) {
  const upsert = db.prepare(`
    INSERT INTO users (id, username, passwordHash, createdAt, email)
    VALUES (@id, @username, @passwordHash, @createdAt, @email)
    ON CONFLICT(id) DO UPDATE SET
      username=excluded.username,
      passwordHash=excluded.passwordHash,
      email=excluded.email
  `);
  db.transaction(() => users.forEach(u => upsert.run({ email: null, ...u })))();
}

const _upsertTracker = db.prepare(`
  INSERT INTO trackers
    (id, userId, label, url, interval, active, status, lastCheck, lastHash,
     lastBody, httpStatus, changeCount, changeSummary, changeSnippet, error,
     aiSummary, createdAt, position)
  VALUES
    (@id, @userId, @label, @url, @interval, @active, @status, @lastCheck, @lastHash,
     @lastBody, @httpStatus, @changeCount, @changeSummary, @changeSnippet, @error,
     @aiSummary, @createdAt, @position)
  ON CONFLICT(id) DO UPDATE SET
    label=excluded.label, url=excluded.url, interval=excluded.interval,
    active=excluded.active, status=excluded.status, lastCheck=excluded.lastCheck,
    lastHash=excluded.lastHash, lastBody=excluded.lastBody, httpStatus=excluded.httpStatus,
    changeCount=excluded.changeCount, changeSummary=excluded.changeSummary,
    changeSnippet=excluded.changeSnippet, error=excluded.error,
    aiSummary=excluded.aiSummary, position=excluded.position
`);

function saveTrackers(list) {
  const incomingIds = list.map(t => t.id);
  db.transaction(() => {
    list.forEach((t, i) => {
      _upsertTracker.run({
        ...t,
        active:        t.active       ? 1 : 0,
        aiSummary:     t.aiSummary === false ? 0 : 1,
        changeSnippet: t.changeSnippet ? JSON.stringify(t.changeSnippet) : null,
        position:      i,
      });
    });
    // Remove DB rows no longer present in the in-memory list
    if (incomingIds.length > 0) {
      const placeholders = incomingIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM trackers WHERE id NOT IN (${placeholders})`).run(...incomingIds);
    } else {
      db.prepare('DELETE FROM trackers').run();
    }
  })();

  // SSE broadcast per-user, strip lastBody
  const byUser = {};
  list.forEach(t => {
    const uid = t.userId || '_anon';
    if (!byUser[uid]) byUser[uid] = [];
    byUser[uid].push(t);
  });
  Object.entries(byUser).forEach(([userId, userTrackers]) => {
    const safe = userTrackers.map(({ lastBody, ...rest }) => rest);
    broadcastToUser({ type: 'update', trackers: safe }, userId);
  });
}

function saveChange(change) {
  db.prepare(`
    INSERT INTO changes (id, trackerId, trackerLabel, url, detectedAt, summary, oldHash, newHash)
    VALUES (@id, @trackerId, @trackerLabel, @url, @detectedAt, @summary, @oldHash, @newHash)
  `).run(change);
  // Keep only the most recent 500 change records
  db.prepare(`
    DELETE FROM changes WHERE id NOT IN (
      SELECT id FROM changes ORDER BY detectedAt DESC LIMIT 500
    )
  `).run();
}

let trackers = loadTrackers();

// ─── SEED SUPER-ADMIN ────────────────────────────────────────────────────────
(async () => {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('wpnadmin');
  if (!existing) {
    const hash = await bcrypt.hash('vladimir', 12);
    db.prepare(`INSERT INTO users (id, username, passwordHash, createdAt, role)
                VALUES (?, 'wpnadmin', ?, ?, 'superadmin')`).
      run(uuidv4(), hash, new Date().toISOString());
    console.log('  ✓ Super-admin account created (wpnadmin)');
  } else {
    // Ensure the role is set correctly even if the account pre-existed
    db.prepare('UPDATE users SET role = ? WHERE username = ?').run('superadmin', 'wpnadmin');
  }
})();

// ─── VISIBLE TEXT EXTRACTION ──────────────────────────────────────────────────
// Strips scripts, styles, comments and all HTML tags — leaving only the words
// a user would actually read. This prevents false-positive change detection
// caused by rotating nonces, cache-busting tokens, or inline timestamps.
function extractVisibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── HASHING ─────────────────────────────────────────────────────────────────
function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
async function fetchResource(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent':      'Watchdog-ChangeTracker/1.0',
      'Accept':          '*/*',
      'Cache-Control':   'no-cache, no-store',
      'Pragma':          'no-cache'
    },
    responseType: 'text',
    validateStatus: () => true
  });
  return {
    status:  response.status,
    headers: response.headers,
    body:    typeof response.data === 'string'
               ? response.data
               : JSON.stringify(response.data)
  };
}

// ─── AI SUMMARY ───────────────────────────────────────────────────────────────
async function getChangeSummary(oldText, newText, url) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'Content changed (set ANTHROPIC_API_KEY for AI summaries).';

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role:    'user',
          content: `You are a concise change-detection assistant. Compare these two snapshots of visible webpage text and describe what changed in 1-2 plain English sentences. Be specific (new content, removed content, updated values). Do not mention HTML.\n\nURL: ${url}\n\n--- BEFORE ---\n${oldText.slice(0, 2500)}\n\n--- AFTER ---\n${newText.slice(0, 2500)}`
        }]
      },
      {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json'
        },
        timeout: 20000
      }
    );
    return res.data?.content?.[0]?.text || 'Content changed.';
  } catch (err) {
    console.error('AI summary error:', err.message);
    return 'Content changed (AI summary unavailable).';
  }
}

// ─── CORE CHECK ───────────────────────────────────────────────────────────────
function computeDiffSnippet(oldText, newText) {
  const CONTEXT  = 12; // words of context each side
  const MAX_CHARS = 400;

  const ow = oldText.split(/\s+/).filter(Boolean);
  const nw = newText.split(/\s+/).filter(Boolean);

  // Find first differing word
  let start = 0;
  const minLen = Math.min(ow.length, nw.length);
  while (start < minLen && ow[start] === nw[start]) start++;
  if (start === ow.length && start === nw.length) return null; // identical

  // Find last differing word from the end
  let oEnd = ow.length - 1;
  let nEnd = nw.length - 1;
  while (oEnd > start && nEnd > start && ow[oEnd] === nw[nEnd]) { oEnd--; nEnd--; }

  const ctxStart = Math.max(0, start - CONTEXT);
  let removed = ow.slice(ctxStart, oEnd + 1 + CONTEXT).join(' ');
  let added   = nw.slice(ctxStart, nEnd + 1 + CONTEXT).join(' ');
  if (removed.length > MAX_CHARS) removed = removed.slice(0, MAX_CHARS) + '…';
  if (added.length   > MAX_CHARS) added   = added.slice(0, MAX_CHARS)   + '…';
  return {
    removed: (ctxStart > 0 ? '… ' : '') + removed,
    added:   (ctxStart > 0 ? '… ' : '') + added
  };
}

async function checkTracker(tracker) {
  const now = new Date().toISOString();
  console.log(`[${now}] Checking: ${tracker.url}`);

  try {
    const { status, body } = await fetchResource(tracker.url);
    const visibleText = extractVisibleText(body);
    const hash = hashContent(visibleText);

    tracker.lastCheck  = now;
    tracker.httpStatus = status;
    tracker.error      = null;

    if (tracker.lastHash == null) {
      // First check — store baseline, no alert
      tracker.lastHash = hash;
      tracker.lastBody = visibleText;
      tracker.status   = 'ok';
      tracker.changeSummary = null;
      console.log(`  ✓ Baseline stored for "${tracker.label}"`);

    } else if (hash !== tracker.lastHash) {
      console.log(`  ⚡ Change detected for "${tracker.label}"${tracker.aiSummary === false ? ' (AI summary disabled)' : ' — fetching AI summary…'}`);

      let summary;
      if (tracker.aiSummary === false) {
        summary = 'Content changed (AI summary disabled for this resource).';
      } else {
        summary = await getChangeSummary(tracker.lastBody, visibleText, tracker.url);
      }

      tracker.changeCount   = (tracker.changeCount || 0) + 1;
      tracker.status        = 'changed';
      tracker.changeSummary = summary;
      tracker.changeSnippet = computeDiffSnippet(tracker.lastBody || '', visibleText);

      saveChange({
        id:           uuidv4(),
        trackerId:    tracker.id,
        trackerLabel: tracker.label,
        url:          tracker.url,
        detectedAt:   now,
        summary,
        oldHash:      tracker.lastHash,
        newHash:      hash
      });

      tracker.lastHash = hash;
      tracker.lastBody = visibleText;
      console.log(`  ✓ Recorded: ${summary}`);

    } else {
      tracker.status = 'ok';
      console.log(`  ✓ No change for "${tracker.label}"`);
    }

  } catch (err) {
    tracker.status    = 'error';
    tracker.lastCheck = now;
    tracker.error     = err.message;
    console.error(`  ✗ Error checking "${tracker.label}": ${err.message}`);
  }

  saveTrackers(trackers);
  return tracker;
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
const activeTimers = {};

function startTrackerTimer(tracker) {
  stopTrackerTimer(tracker.id);
  if (!tracker.active) return;
  activeTimers[tracker.id] = setInterval(async () => {
    const t = trackers.find(t => t.id === tracker.id);
    if (t && t.active) await checkTracker(t);
  }, tracker.interval);
  console.log(`Scheduled "${tracker.label}" every ${tracker.interval / 1000}s`);
}

function stopTrackerTimer(id) {
  if (activeTimers[id]) { clearInterval(activeTimers[id]); delete activeTimers[id]; }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Map(); // clientId → { res, userId }

function broadcastToUser(event, userId) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(({ res, userId: cUid }) => {
    if (cUid === userId) { try { res.write(data); } catch {} }
  });
}

app.get('/api/events', authMiddleware, (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const clientId = uuidv4();
  sseClients.set(clientId, { res, userId: req.userId });
  console.log(`SSE client connected: ${clientId} (user: ${req.username})`);

  const userTrackers = trackers
    .filter(t => t.userId === req.userId)
    .map(({ lastBody, ...rest }) => rest);
  res.write(`data: ${JSON.stringify({ type: 'init', trackers: userTrackers })}\n\n`);

  req.on('close', () => {
    sseClients.delete(clientId);
    console.log(`SSE client disconnected: ${clientId}`);
  });
});

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.cookies?.watchdog_auth;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(payload.userId);
    if (!user) {
      res.clearCookie('watchdog_auth');
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (user.disabled) {
      res.clearCookie('watchdog_auth');
      return res.status(403).json({ error: 'Account is disabled' });
    }
    req.userId   = payload.userId;
    req.username = payload.username;
    req.role     = payload.role || 'user';
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (!email?.trim())
    return res.status(400).json({ error: 'Email address is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: 'Please enter a valid email address' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existingUsername = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
  if (existingUsername) return res.status(409).json({ error: 'That username is already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id: uuidv4(), username: username.trim(), email: email.trim().toLowerCase(), passwordHash, createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO users (id, username, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, user.username, user.email, user.passwordHash, user.createdAt);

  const token = jwt.sign({ userId: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchdog_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.status(201).json({ id: user.id, username: user.username, role: 'user', notificationsEnabled: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  const users = loadUsers();
  const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  if (user.disabled) return res.status(403).json({ error: 'Your account has been deactivated. Please contact an administrator.' });

  const token = jwt.sign({ userId: user.id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchdog_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({ id: user.id, username: user.username, role: user.role || 'user', notificationsEnabled: user.notificationsEnabled !== 0 });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('watchdog_auth');
  res.clearCookie('watchdog_restore');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.watchdog_auth;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT role, disabled, notificationsEnabled FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.disabled) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ id: payload.userId, username: payload.username, role: user.role || 'user', notificationsEnabled: user.notificationsEnabled !== 0,
      ...(payload.impersonatedBy ? { impersonatedBy: payload.impersonatedBy } : {}) });
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

app.get('/api/auth/profile', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, createdAt, notificationsEnabled FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, notificationsEnabled: user.notificationsEnabled !== 0 });
});

app.delete('/api/auth/profile', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  trackers.filter(t => t.userId === req.userId).forEach(t => stopTrackerTimer(t.id));
  trackers = trackers.filter(t => t.userId !== req.userId);
  db.prepare('DELETE FROM changes WHERE trackerId IN (SELECT id FROM trackers WHERE userId = ?)').run(req.userId);
  db.prepare('DELETE FROM trackers WHERE userId = ?').run(req.userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
  res.clearCookie('watchdog_auth');
  res.json({ success: true });
});

app.patch('/api/auth/profile', authMiddleware, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  if (email === undefined && newPassword === undefined && req.body.notificationsEnabled === undefined)
    return res.status(400).json({ error: 'Nothing to update' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (email !== undefined) {
    const trimmed = (email || '').trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      return res.status(400).json({ error: 'Invalid email address' });
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(trimmed || null, req.userId);
  }

  if (req.body.notificationsEnabled !== undefined) {
    db.prepare('UPDATE users SET notificationsEnabled = ? WHERE id = ?')
      .run(req.body.notificationsEnabled ? 1 : 0, req.userId);
  }

  if (newPassword !== undefined) {
    if (!currentPassword)
      return res.status(400).json({ error: 'Current password is required' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, req.userId);
  }

  res.json({ success: true });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/admin/users', adminMiddleware, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (!email?.trim())
    return res.status(400).json({ error: 'Email address is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: 'Please enter a valid email address' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const allowedRoles = ['user', 'superadmin'];
  const assignedRole = allowedRoles.includes(role) ? role : 'user';

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
  if (existing) return res.status(409).json({ error: 'That username is already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id: uuidv4(), username: username.trim(), email: email.trim().toLowerCase(), passwordHash, role: assignedRole, createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO users (id, username, email, passwordHash, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, user.username, user.email, user.passwordHash, user.role, user.createdAt);
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, email, role, createdAt, disabled, trackerLimit FROM users ORDER BY createdAt ASC').all();
  const trackerCounts = {};
  trackers.forEach(t => { trackerCounts[t.userId] = (trackerCounts[t.userId] || 0) + 1; });
  res.json(users.map(u => ({ ...u, disabled: u.disabled === 1, trackerCount: trackerCounts[u.id] || 0 })));
});

app.patch('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot modify your own account this way' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { disabled, trackerLimit, email, role } = req.body;

  if (disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, targetId);
    if (disabled) {
      // Force-logout active sessions
      const msg = `data: ${JSON.stringify({ type: 'force_logout' })}\n\n`;
      sseClients.forEach((client, clientId) => {
        if (client.userId === targetId) {
          try { client.res.write(msg); client.res.end(); } catch {}
          sseClients.delete(clientId);
        }
      });
    }
  }

  if (trackerLimit !== undefined) {
    const limit = trackerLimit === null ? null : parseInt(trackerLimit);
    if (limit !== null && (isNaN(limit) || limit < 0))
      return res.status(400).json({ error: 'Invalid tracker limit' });
    db.prepare('UPDATE users SET trackerLimit = ? WHERE id = ?').run(limit, targetId);
  }

  if (email !== undefined) {
    const trimmed = email?.trim() || null;
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      return res.status(400).json({ error: 'Please enter a valid email address' });
    if (trimmed) {
      const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, targetId);
      if (conflict) return res.status(409).json({ error: 'An account with that email already exists' });
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(trimmed ? trimmed.toLowerCase() : null, targetId);
  }

  if (role !== undefined) {
    const allowedRoles = ['user', 'superadmin'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  }

  res.json({ success: true });
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Stop & remove all their trackers
  trackers.filter(t => t.userId === targetId).forEach(t => stopTrackerTimer(t.id));
  trackers = trackers.filter(t => t.userId !== targetId);
  db.prepare('DELETE FROM changes WHERE trackerId IN (SELECT id FROM trackers WHERE userId = ?)').run(targetId);
  db.prepare('DELETE FROM trackers WHERE userId = ?').run(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

  // Force-logout any active SSE sessions for the deleted user
  const forceLogout = `data: ${JSON.stringify({ type: 'force_logout' })}\n\n`;
  sseClients.forEach((client, clientId) => {
    if (client.userId === targetId) {
      try { client.res.write(forceLogout); client.res.end(); } catch {}
      sseClients.delete(clientId);
    }
  });

  res.json({ success: true });
});

app.get('/api/admin/trackers', adminMiddleware, (req, res) => {
  res.json(trackers.map(({ lastBody, ...rest }) => rest));
});

app.delete('/api/admin/trackers/:id', adminMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  stopTrackerTimer(tracker.id);
  trackers = trackers.filter(t => t.id !== tracker.id);
  saveTrackers(trackers);
  res.json({ success: true });
});

app.post('/api/admin/impersonate/:id', adminMiddleware, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot impersonate yourself' });
  const target = db.prepare('SELECT id, username, role, notificationsEnabled FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.disabled) return res.status(400).json({ error: 'Cannot impersonate a disabled account' });

  // Save the admin's current token so they can return later
  const adminToken = req.cookies.watchdog_auth;
  res.cookie('watchdog_restore', adminToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });

  const impersonateToken = jwt.sign(
    { userId: target.id, username: target.username, role: target.role || 'user',
      impersonatedBy: { id: req.userId, username: req.username } },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.cookie('watchdog_auth', impersonateToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({ id: target.id, username: target.username, role: target.role || 'user',
    notificationsEnabled: target.notificationsEnabled !== 0,
    impersonatedBy: { id: req.userId, username: req.username } });
});

app.post('/api/admin/stop-impersonate', (req, res) => {
  const restoreToken = req.cookies?.watchdog_restore;
  if (!restoreToken) return res.status(400).json({ error: 'No impersonation session to restore' });
  try {
    jwt.verify(restoreToken, JWT_SECRET);
  } catch {
    res.clearCookie('watchdog_restore');
    res.clearCookie('watchdog_auth');
    return res.status(401).json({ error: 'Restore token invalid or expired' });
  }
  res.cookie('watchdog_auth', restoreToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.clearCookie('watchdog_restore');
  const payload = jwt.decode(restoreToken);
  const user = db.prepare('SELECT role, notificationsEnabled FROM users WHERE id = ?').get(payload.userId);
  res.json({ id: payload.userId, username: payload.username, role: user?.role || 'superadmin',
    notificationsEnabled: user?.notificationsEnabled !== 0 });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { oldText, newText, url } = req.body;
  const summary = await getChangeSummary(oldText, newText, url);
  res.json({ summary });
});

app.get('/api/trackers', authMiddleware, (req, res) => {
  res.json(
    trackers
      .filter(t => t.userId === req.userId)
      .map(({ lastBody, ...rest }) => rest)
  );
});

app.post('/api/trackers', authMiddleware, async (req, res) => {
  const { url, label, interval, aiSummary } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const userRow = db.prepare('SELECT trackerLimit FROM users WHERE id = ?').get(req.userId);
  if (userRow?.trackerLimit != null) {
    const count = trackers.filter(t => t.userId === req.userId).length;
    if (count >= userRow.trackerLimit)
      return res.status(403).json({ error: `Tracker limit reached (${userRow.trackerLimit})` });
  }

  const tracker = {
    id: uuidv4(), url,
    label:        label || url,
    interval:     interval || 30000,
    active:       true,
    status:       'pending',
    lastCheck:    null,
    lastHash:     null,
    lastBody:     null,
    httpStatus:   null,
    changeCount:  0,
    changeSummary: null,
    error:        null,
    aiSummary:    aiSummary === true,
    createdAt:    new Date().toISOString(),
    userId:       req.userId
  };

  trackers.unshift(tracker);
  saveTrackers(trackers);
  startTrackerTimer(tracker);
  checkTracker(tracker); // fire-and-forget first check

  const { lastBody, ...safe } = tracker;
  res.status(201).json(safe);
});

app.patch('/api/trackers/reorder', authMiddleware, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  const userIds = new Set(
    trackers.filter(t => t.userId === req.userId).map(t => t.id)
  );
  if (ids.some(id => !userIds.has(id)))
    return res.status(403).json({ error: 'Forbidden' });

  const posMap = {};
  ids.forEach((id, i) => { posMap[id] = i; });

  trackers.sort((a, b) => {
    const aIsUser = a.userId === req.userId;
    const bIsUser = b.userId === req.userId;
    if (aIsUser && bIsUser) return (posMap[a.id] ?? 0) - (posMap[b.id] ?? 0);
    return 0;
  });

  saveTrackers(trackers);
  res.json({ success: true });
});

app.delete('/api/trackers/:id', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  stopTrackerTimer(req.params.id);
  trackers = trackers.filter(t => t.id !== req.params.id);
  saveTrackers(trackers);
  res.json({ success: true });
});

app.patch('/api/trackers/:id', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  ['active', 'label', 'interval', 'aiSummary'].forEach(k => {
    if (req.body[k] !== undefined) tracker[k] = req.body[k];
  });
  if (req.body.active === false) stopTrackerTimer(tracker.id);
  else if (tracker.active) startTrackerTimer(tracker); // restart on any change (interval, active toggle)
  saveTrackers(trackers);
  const { lastBody, ...safe } = tracker;
  res.json(safe);
});

app.post('/api/trackers/:id/check', authMiddleware, async (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  const updated = await checkTracker(tracker);
  const { lastBody, ...safe } = updated;
  res.json(safe);
});

app.post('/api/trackers/:id/dismiss', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  tracker.status        = 'ok';
  tracker.changeSummary = null;
  tracker.changeSnippet = null;
  saveTrackers(trackers);
  res.json({ success: true });
});

app.get('/api/changes', authMiddleware, (req, res) => {
  const limit     = parseInt(req.query.limit) || 50;
  const trackerId = req.query.trackerId;
  // Only return changes for trackers owned by the requesting user
  const userTrackerIds = new Set(trackers.filter(t => t.userId === req.userId).map(t => t.id));
  let changes = loadChanges().filter(c => userTrackerIds.has(c.trackerId));
  if (trackerId) changes = changes.filter(c => c.trackerId === trackerId);
  res.json(changes.slice(0, limit));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🐕 Watchdog running at http://localhost:${PORT}`);
  console.log(`   AI summaries: ${process.env.ANTHROPIC_API_KEY ? '✓ enabled' : '✗ set ANTHROPIC_API_KEY to enable'}\n`);
  trackers.forEach(t => { if (t.active) startTrackerTimer(t); });
});
