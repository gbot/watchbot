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

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
const DB_FILE      = path.join(__dirname, '../data/trackers.json');
const CHANGES_FILE = path.join(__dirname, '../data/changes.json');
const USERS_FILE   = path.join(__dirname, '../data/users.json');

function ensureDataDir() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTrackers() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}

function loadChanges() {
  ensureDataDir();
  if (!fs.existsSync(CHANGES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); }
  catch { return []; }
}

function loadUsers() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function saveTrackers(list) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
  // Broadcast per-user so each SSE client only receives their own trackers
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
  const changes = loadChanges();
  changes.unshift(change);
  fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes.slice(0, 500), null, 2));
}

let trackers = loadTrackers();

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
    req.userId   = payload.userId;
    req.username = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.trim().toLowerCase()))
    return res.status(409).json({ error: 'That username is already taken' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id: uuidv4(), username: username.trim(), passwordHash, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchdog_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.status(201).json({ id: user.id, username: user.username });
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

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchdog_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('watchdog_auth');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.watchdog_auth;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ id: payload.userId, username: payload.username });
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
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
  const { url, label, interval } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

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
