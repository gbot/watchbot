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
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'watchbot-fallback-secret-change-in-production';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ─── LOGGER ──────────────────────────────────────────────────────────────────
const _c = {
  r: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
function log(symbol, color, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`${_c.dim}${ts}${_c.r}  ${color}${symbol}${_c.r}  ${msg}\n`);
}

// ─── CLAUDE MODEL RESOLVER ────────────────────────────────────────────────────
const _modelAliases = {
  'sonnet-4':   'claude-sonnet-4-20250514',
  'sonnet4':    'claude-sonnet-4-20250514',
  'sonnet':     'claude-sonnet-4-20250514',
  'sonnet-3.5': 'claude-3-5-sonnet-20241022',
  'sonnet3.5':  'claude-3-5-sonnet-20241022',
  'sonnet-3':   'claude-3-5-sonnet-20241022',
  'opus-4':     'claude-opus-4-5',
  'opus4':      'claude-opus-4-5',
  'opus':       'claude-opus-4-5',
  'opus-3':     'claude-3-opus-20240229',
  'haiku':      'claude-3-5-haiku-20241022',
  'haiku-3.5':  'claude-3-5-haiku-20241022',
  'haiku3.5':   'claude-3-5-haiku-20241022',
};
const CLAUDE_MODEL = (() => {
  const raw = (process.env.CLAUDE_MODEL || 'sonnet-4').trim().toLowerCase();
  return _modelAliases[raw] || process.env.CLAUDE_MODEL.trim();
})();
log('✦', _c.magenta, `Claude model: ${CLAUDE_MODEL}`);

// ─── PERSISTENCE (SQLite) ─────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const DATA_DIR  = path.join(__dirname, '../data');
const DB_PATH   = path.join(DATA_DIR, 'watchbot.db');

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
try { db.exec('ALTER TABLE users ADD COLUMN globalEmailNotify   INTEGER NOT NULL DEFAULT 1'); } catch {}

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
    position      INTEGER DEFAULT 0,
    emailNotify   INTEGER DEFAULT 0
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

// Migrations for existing DBs
try { db.prepare('ALTER TABLE changes ADD COLUMN dismissed INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN locked   INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN soft      INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN snippet   TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE trackers ADD COLUMN emailNotify INTEGER DEFAULT 0').run(); } catch {}

// Indexes for query performance — idempotent, safe to run on every startup
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_changes_trackerId  ON changes(trackerId);
  CREATE INDEX IF NOT EXISTS idx_changes_detectedAt ON changes(detectedAt);
  CREATE INDEX IF NOT EXISTS idx_trackers_userId    ON trackers(userId);
`);

// Pre-compiled statements used in hot paths (parsed once, reused on every call)
const _selectUserForAuth = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?');

function rowToTracker(row) {
  return {
    ...row,
    active:       row.active      === 1,
    aiSummary:    row.aiSummary   !== 0,
    emailNotify:  row.emailNotify === 1,
    changeSnippet: row.changeSnippet ? JSON.parse(row.changeSnippet) : null,
  };
}

function loadTrackers() {
  const rows    = db.prepare('SELECT * FROM trackers ORDER BY position ASC').all();
  const lockMap = {};
  db.prepare('SELECT trackerId, COUNT(*) as c FROM changes WHERE locked = 1 GROUP BY trackerId')
    .all().forEach(r => { lockMap[r.trackerId] = r.c; });
  return rows.map(row => ({ ...rowToTracker(row), lockedCount: lockMap[row.id] || 0 }));
}

function loadChanges() {
  return db.prepare('SELECT * FROM changes ORDER BY detectedAt DESC').all();
}

function loadUsers() {
  return db.prepare('SELECT * FROM users').all();
}

const _upsertTracker = db.prepare(`
  INSERT INTO trackers
    (id, userId, label, url, interval, active, status, lastCheck, lastHash,
     lastBody, httpStatus, changeCount, changeSummary, changeSnippet, error,
     aiSummary, createdAt, position, emailNotify)
  VALUES
    (@id, @userId, @label, @url, @interval, @active, @status, @lastCheck, @lastHash,
     @lastBody, @httpStatus, @changeCount, @changeSummary, @changeSnippet, @error,
     @aiSummary, @createdAt, @position, @emailNotify)
  ON CONFLICT(id) DO UPDATE SET
    label=excluded.label, url=excluded.url, interval=excluded.interval,
    active=excluded.active, status=excluded.status, lastCheck=excluded.lastCheck,
    lastHash=excluded.lastHash, lastBody=excluded.lastBody, httpStatus=excluded.httpStatus,
    changeCount=excluded.changeCount, changeSummary=excluded.changeSummary,
    changeSnippet=excluded.changeSnippet, error=excluded.error,
    aiSummary=excluded.aiSummary, position=excluded.position, emailNotify=excluded.emailNotify
`);

function saveTrackers(list) {
  const incomingIds = list.map(t => t.id);
  const incomingUserIds = new Set(list.map(t => t.userId).filter(Boolean));

  // Identify users who will have ALL their trackers removed so we can broadcast
  // an empty list to any open tabs they have — without this they'd see stale data.
  let emptyUserIds = [];
  if (incomingIds.length > 0) {
    const ph = incomingIds.map(() => '?').join(',');
    emptyUserIds = db.prepare(
      `SELECT DISTINCT userId FROM trackers WHERE id NOT IN (${ph})`
    ).all(...incomingIds)
      .map(r => r.userId)
      .filter(uid => uid && !incomingUserIds.has(uid));
  } else {
    emptyUserIds = db.prepare('SELECT DISTINCT userId FROM trackers').all().map(r => r.userId);
  }

  db.transaction(() => {
    list.forEach((t, i) => {
      _upsertTracker.run({
        ...t,
        active:        t.active       ? 1 : 0,
        aiSummary:     t.aiSummary === false ? 0 : 1,
        emailNotify:   t.emailNotify  ? 1 : 0,
        changeSnippet: t.changeSnippet ? JSON.stringify(t.changeSnippet) : null,
        position:      i,
      });
    });
    // Remove DB rows no longer present in the in-memory list
    if (incomingIds.length > 0) {
      const placeholders = incomingIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM changes WHERE trackerId NOT IN (${placeholders})`).run(...incomingIds);
      db.prepare(`DELETE FROM trackers WHERE id NOT IN (${placeholders})`).run(...incomingIds);
    } else {
      db.prepare('DELETE FROM changes').run();
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
  // Notify users who lost all their trackers (clears stale tracker lists in other tabs)
  emptyUserIds.forEach(uid => broadcastToUser({ type: 'update', trackers: [] }, uid));
}

// Lightweight single-tracker save used during check cycles.
// Upserts only one row and broadcasts only to that user — avoids re-writing
// every tracker and running orphan-cleanup queries on each check.
function _saveOneTracker(tracker) {
  _upsertTracker.run({
    ...tracker,
    active:        tracker.active       ? 1 : 0,
    aiSummary:     tracker.aiSummary === false ? 0 : 1,
    emailNotify:   tracker.emailNotify  ? 1 : 0,
    changeSnippet: tracker.changeSnippet ? JSON.stringify(tracker.changeSnippet) : null,
    position:      trackers.indexOf(tracker),
  });
  const userTrackers = trackers.filter(t => t.userId === tracker.userId);
  broadcastToUser(
    { type: 'update', trackers: userTrackers.map(({ lastBody, ...rest }) => rest) },
    tracker.userId
  );
}

// Classify a summary as a "soft" change — hash drifted (ads, timestamps, nonces)
// but no real content change occurred. Soft changes are auto-dismissed and do
// not trigger notifications so they don't create false-positive noise.
const _softPatterns = [
  // Explicit "identical" verdicts
  /appear(?:s)? to be identical/,
  /identical in content/,
  /essentially identical/,
  /virtually identical/,
  /\bidentical\b.*\bsnapshot\b/,
  // Pages/snapshots look/are the same
  /(?:pages?|snapshots?|versions?) (?:are|look|appear(?:s)?) (?:essentially |virtually |basically |largely )?(?:identical|the same)/,
  // "unchanged" variants
  /(?:content|page|text|site|article).*(?:remains?|is|appears?|seem(?:s)?) (?:essentially |largely |basically |fundamentally |virtually |completely |totally )?unchanged/,
  /(?:remains?|is|appears?) (?:essentially |largely |basically |fundamentally |virtually |completely |totally )?unchanged/,
  // Content/text appears/seems the same
  /(?:content|text|page|site|article) (?:appears?|seems?) (?:to be )?(?:essentially |largely |basically |fundamentally |virtually |completely |totally )?(?:the )?same/,
  // "cannot identify/find/detect any (meaningful) changes/differences" — AI uncertainty phrasing
  /cannot (?:identify|find|detect|see|spot|observe|discern) any (?:new |meaningful |significant |notable |real |substantial |material )?(?:content )?(?:changes?|differences?)/,
  /unable to (?:identify|find|detect|see|spot|observe|discern) any (?:new |meaningful |significant |notable |real |substantial |material )?(?:content )?(?:changes?|differences?)/,
  /could not (?:identify|find|detect|see|spot|observe|discern) any (?:new |meaningful |significant |notable |real |substantial |material )?(?:content )?(?:changes?|differences?)/,
  // "no meaningful/significant/notable content changes/differences"
  /no (?:meaningful|significant|notable|real|substantial|material|discernible|detectable|apparent|major|important) (?:content )?(?:changes?|differences?)/,
  // "no X change/update/difference" variants
  /no (?:new |substantive |meaningful |significant |notable |real |discernible |detectable |material |apparent )(?:change|update|content|difference|story|stories|announcement)/,
  /no (?:change|update|difference|new story|new content|new announcement)s? (?:were |have been |are )?(?:detected|found|identified|observed)/,
  // "no new stories/announcements/updates" phrasing
  /no new (?:stories|story|articles?|announcements?|updates?|posts?|content)/,
  // "changes appear/are trivial/minor/cosmetic"
  /(?:changes?|differences?) (?:are|appear(?:s)?|seem(?:s)?) (?:to be )?(?:trivial|minor|cosmetic|insignificant|negligible|superficial)/,
  // Passive "nothing changed" variants
  /nothing (?:has |have )?changed/,
  /(?:content|page) (?:appears?|seems?) to (?:remain|be) the same/,
];

function isSoftChange(summary) {
  if (!summary) return false;
  const s = summary.toLowerCase();
  return _softPatterns.some(re => re.test(s));
}

// ─── PRE-FLIGHT TEXT SIMILARITY ───────────────────────────────────────────────
// Word-frequency diff: counts how many word tokens were added or removed
// (ignoring order). When fewer than MINOR_ABS words changed AND those changes
// represent less than MINOR_PCT of the total content, we can skip the AI call
// entirely — the diff is almost certainly a counter, timestamp, or ad nonce.
const MINOR_ABS = 20;    // absolute word-frequency change ceiling
const MINOR_PCT = 0.02;  // 2 % relative change ceiling

function _wordFreq(text) {
  const m = {};
  for (const w of text.split(/\s+/)) if (w) m[w] = (m[w] || 0) + 1;
  return m;
}

function _isMinorTextChange(oldText, newText) {
  if (!oldText || !newText) return false;
  const om = _wordFreq(oldText);
  const nm = _wordFreq(newText);
  // Quick length guard — if the page grew or shrank by more than the
  // percentage threshold, fast-fail without scanning every word.
  const ow = Object.values(om).reduce((a, b) => a + b, 0);
  const nw = Object.values(nm).reduce((a, b) => a + b, 0);
  if (Math.abs(ow - nw) > MINOR_ABS) return false;
  // Count net token additions + removals across the vocabulary
  const vocab = new Set([...Object.keys(om), ...Object.keys(nm)]);
  let delta = 0;
  for (const w of vocab) delta += Math.abs((om[w] || 0) - (nm[w] || 0));
  const total = Math.max(ow, nw, 1);
  return delta <= MINOR_ABS && (delta / total) <= MINOR_PCT;
}

function saveChange(change) {
  const snippetJson = change.snippet ? JSON.stringify(change.snippet) : null;
  db.prepare(`
    INSERT INTO changes (id, trackerId, trackerLabel, url, detectedAt, summary, oldHash, newHash, dismissed, soft, snippet)
    VALUES (@id, @trackerId, @trackerLabel, @url, @detectedAt, @summary, @oldHash, @newHash, @dismissed, @soft, @snippet)
  `).run({ dismissed: 0, soft: 0, snippet: null, ...change, snippet: snippetJson });
  // Only prune when the unlocked pool actually exceeds the cap — avoids a
  // redundant DELETE subquery scan on every save when well under the limit.
  const { c } = db.prepare('SELECT COUNT(*) as c FROM changes WHERE locked = 0').get();
  if (c > 500) {
    db.prepare(`
      DELETE FROM changes WHERE locked = 0 AND id NOT IN (
        SELECT id FROM changes WHERE locked = 0 ORDER BY detectedAt DESC LIMIT 500
      )
    `).run();
  }
}

// Repair any status desync that may have persisted to the DB before this fix.
// A tracker whose status was saved as 'ok' (or 'error') while it still has
// undismissed, unlocked changes should have status 'changed' so the 'New only'
// filter and the unread badge work correctly from the very first SSE init.
db.prepare(`
  UPDATE trackers
  SET    status = 'changed'
  WHERE  status != 'changed'
  AND    id IN (
    SELECT DISTINCT trackerId FROM changes WHERE dismissed = 0
  )
`).run();

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

// ─── EMAIL (AWS SES API) ─────────────────────────────────────────────────────
function _isSesConfigured() {
  return !!(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function _sesClient() {
  return new SESClient({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function sendChangeEmail(tracker, summary, owner) {
  if (!_isSesConfigured()) return;
  const from    = process.env.SES_FROM || 'Watchbot <noreply@example.com>';
  const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#6200ea;padding:20px 24px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:600">&#128276; Watchbot — Change Detected</span>
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px">
    <p style="margin:0 0 8px"><strong>WatchBot:</strong> ${tracker.label.replace(/</g,'&lt;')}</p>
    <p style="margin:0 0 16px"><strong>URL:</strong> <a href="${tracker.url}">${tracker.url.replace(/</g,'&lt;')}</a></p>
    <p style="margin:0 0 8px;font-weight:600">Summary</p>
    <div style="background:#f5f5f5;padding:12px 16px;border-radius:6px;font-size:14px;line-height:1.6">${summary.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>
    <p style="margin:16px 0 0;font-size:12px;color:#757575">Detected at ${dateStr}</p>
  </div>
</div>`;
  const text = `Watchbot — Change Detected\n\nWatchBot: ${tracker.label}\nURL: ${tracker.url}\n\nSummary:\n${summary}\n\nDetected at ${dateStr}`;

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [owner.email] },
    Message: {
      Subject: { Data: `Change detected: ${tracker.label}`, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html,  Charset: 'UTF-8' },
        Text: { Data: text,  Charset: 'UTF-8' },
      },
    },
  });
  await _sesClient().send(command);
  log('✉', _c.cyan, `Email sent  "${tracker.label}"  → ${owner.email}`);
}

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

// Structured extraction for AI context — preserves heading hierarchy with
// markers and strips noisy elements (nav, footer, timestamps, sidebars) so
// the model focuses on meaningful content rather than dynamic counters/dates.
function extractStructuredText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip whole noisy semantic blocks
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<time[^>]*>[\s\S]*?<\/time>/gi, '')
    // Promote headings to readable markers
    .replace(/<h1[^>]*>/gi, '\n[H1] ').replace(/<\/h1>/gi, '\n')
    .replace(/<h2[^>]*>/gi, '\n[H2] ').replace(/<\/h2>/gi, '\n')
    .replace(/<h3[^>]*>/gi, '\n[H3] ').replace(/<\/h3>/gi, '\n')
    .replace(/<h4[^>]*>/gi, '\n[H4] ').replace(/<\/h4>/gi, '\n')
    .replace(/<h5[^>]*>/gi, '\n[H5] ').replace(/<\/h5>/gi, '\n')
    .replace(/<h6[^>]*>/gi, '\n[H6] ').replace(/<\/h6>/gi, '\n')
    // Block elements → newlines for readability
    .replace(/<\/?(?:p|div|section|article|main|li|tr|blockquote|pre)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
      'User-Agent':      'Watchbot-ChangeTracker/1.0',
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
        model:      CLAUDE_MODEL,
        max_tokens: 500,
        messages: [{
          role:    'user',
          content: `You are an expert at interpreting web content changes and explaining their real-world significance.

Compare the two snapshots below and write 2-3 plain English sentences describing what actually changed and why it matters.

Prioritise: new stories or announcements, shifts in narrative or stance, newly featured or removed content, changes to key facts, prices, statuses, or decisions.
Ignore entirely: timestamps, relative dates ("X minutes ago"), view/comment/vote/reaction counts, ads, navigation links, and any other dynamic boilerplate.
Do not describe HTML structure, formatting, or page layout.
Write as if briefing someone who cares about this topic — focus on the substance and implications of the change, not just what words appeared or disappeared.\nWhen there are multiple distinct changes, prefer a short bulleted list over a single dense paragraph. Use plain markdown only: bullet points with "- ", bold with **text**, and blank lines between sections. Do not use headers or nested lists.

URL: ${url}

--- BEFORE ---
${oldText.slice(0, 3000)}

--- AFTER ---
${newText.slice(0, 3000)}`
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
    log('✗', _c.red, `AI summary error: ${err.message}`);
    return 'Content changed (AI summary unavailable).';
  }
}

// ─── CORE CHECK ───────────────────────────────────────────────────────────────
function computeDiffSnippet(oldText, newText) {
  const CONTEXT   = 25; // words of context each side
  const MAX_CHARS = 800;

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
  log('↻', _c.dim, `Checking  ${tracker.url}`);

  try {
    const { status, body } = await fetchResource(tracker.url);
    const visibleText    = extractVisibleText(body);
    const structuredText = extractStructuredText(body);
    const hash = hashContent(visibleText);

    tracker.lastCheck  = now;
    tracker.httpStatus = status;
    tracker.error      = null;

    if (tracker.lastHash == null) {
      // First check — store baseline, no alert
      tracker.lastHash = hash;
      tracker.lastBody = structuredText;
      tracker.status   = 'ok';
      tracker.changeSummary = null;
      log('✓', _c.green, `Baseline  "${tracker.label}"  [HTTP ${status}]`);

    } else if (hash !== tracker.lastHash) {
      // Pre-flight: skip the AI call when the word-level diff is tiny.
      // Counters, timestamps, and ad nonces change the hash but produce
      // near-identical text — no need to pay for a "no changes" summary.
      const preflightSoft = tracker.lastBody
        ? _isMinorTextChange(tracker.lastBody, structuredText)
        : false;

      log('⚡', _c.yellow, `Changed   "${tracker.label}"  [HTTP ${status}]${
        preflightSoft                  ? '  — minor diff, skipping AI' :
        tracker.aiSummary === false    ? '' :
                                         '  — fetching AI summary…'
      }`);

      let summary;
      if (preflightSoft) {
        summary = 'No significant content changes detected.';
      } else if (tracker.aiSummary === false) {
        summary = 'Content changed.';
      } else {
        summary = await getChangeSummary(tracker.lastBody, structuredText, tracker.url);
      }

      const soft    = preflightSoft || isSoftChange(summary);
      const snippet = computeDiffSnippet(tracker.lastBody || '', structuredText);

      tracker.changeCount = (tracker.changeCount || 0) + 1;
      if (!soft) {
        tracker.status        = 'changed';
        tracker.changeSummary = summary;
        tracker.changeSnippet = snippet;
      }

      saveChange({
        id:           uuidv4(),
        trackerId:    tracker.id,
        trackerLabel: tracker.label,
        url:          tracker.url,
        detectedAt:   now,
        summary,
        oldHash:      tracker.lastHash,
        newHash:      hash,
        dismissed:    soft ? 1 : 0,
        soft:         soft ? 1 : 0,
        snippet,
      });

      tracker.lastHash = hash;
      tracker.lastBody = structuredText;
      log(soft ? '~' : '⚡', soft ? _c.dim : _c.yellow, `${soft ? 'Soft chg  ' : 'Saved     '} "${tracker.label}"  — ${summary.slice(0, 120)}`);

      // Fire email notification only for real (non-soft) changes,
      // and only when the user's global email toggle is enabled.
      if (!soft && tracker.emailNotify) {
        const owner = db.prepare('SELECT email, globalEmailNotify FROM users WHERE id = ?').get(tracker.userId);
        if (owner?.email && owner.globalEmailNotify !== 0) {
          sendChangeEmail(tracker, summary, owner).catch(err =>
            log('✗', _c.red, `Email error "${tracker.label}": ${err.message}`)
          );
        }
      }

    } else {
      // Only move back to 'ok' if there are no unread (undismissed, unlocked)
      // changes waiting for the user — otherwise a routine no-change check
      // would silently reset the 'changed' status and break the 'New only' filter.
      const undismissed = db.prepare(
        'SELECT COUNT(*) as c FROM changes WHERE trackerId = ? AND dismissed = 0'
      ).get(tracker.id).c;
      tracker.status = undismissed > 0 ? 'changed' : 'ok';
      log('·', _c.dim, `No change "${tracker.label}"  [HTTP ${status}]`);
    }

  } catch (err) {
    tracker.status    = 'error';
    tracker.lastCheck = now;
    tracker.error     = err.message;
    log('✗', _c.red, `Error     "${tracker.label}"  — ${err.message}`);
  }

  _saveOneTracker(tracker);
  return tracker;
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
const activeTimers = {};

// Concurrency queue — prevents thundering herd when many trackers share the
// same interval. At most CHECK_CONCURRENCY checks run in parallel; any timer
// that fires for a tracker already in-flight is silently dropped.
const CHECK_CONCURRENCY = parseInt(process.env.CHECK_CONCURRENCY) || 5;
let   _queueRunning = 0;
const _checkQueue   = [];  // ordered list of tracker IDs waiting to run
const _inFlight     = new Set(); // IDs currently inside checkTracker

function enqueueCheck(tracker) {
  if (_inFlight.has(tracker.id)) return;  // already running — drop duplicate
  _checkQueue.push(tracker.id);
  _drainCheckQueue();
}

function _drainCheckQueue() {
  while (_queueRunning < CHECK_CONCURRENCY && _checkQueue.length > 0) {
    const id = _checkQueue.shift();
    if (_inFlight.has(id)) continue;   // queued twice — skip
    const t = trackers.find(t => t.id === id);
    if (!t || !t.active) continue;     // removed or paused while waiting
    _inFlight.add(id);
    _queueRunning++;
    checkTracker(t).finally(() => {
      _inFlight.delete(id);
      _queueRunning--;
      _drainCheckQueue();
    });
  }
}

function startTrackerTimer(tracker) {
  stopTrackerTimer(tracker.id);
  if (!tracker.active) return;
  activeTimers[tracker.id] = setInterval(() => {
    const t = trackers.find(t => t.id === tracker.id);
    if (t && t.active) enqueueCheck(t);
  }, tracker.interval);
  log('⏱', _c.blue, `Scheduled "${tracker.label}" every ${tracker.interval / 1000}s`);
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
  log('⇄', _c.cyan, `SSE connected    ${req.username}  (${clientId.slice(0, 8)})`);

  const userTrackers = trackers
    .filter(t => t.userId === req.userId)
    .map(({ lastBody, ...rest }) => rest);
  res.write(`data: ${JSON.stringify({ type: 'init', trackers: userTrackers })}\n\n`);

  req.on('close', () => {
    sseClients.delete(clientId);
    log('⇄', _c.dim, `SSE disconnected ${req.username}  (${clientId.slice(0, 8)})`);
  });
});

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.cookies?.watchbot_auth;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = _selectUserForAuth.get(payload.userId);
    if (!user) {
      res.clearCookie('watchbot_auth');
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    // Only block disabled accounts for their own sessions, not for admin impersonation
    if (user.disabled && !payload.impersonatedBy) {
      res.clearCookie('watchbot_auth');
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
  res.cookie('watchbot_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
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
  res.cookie('watchbot_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({ id: user.id, username: user.username, role: user.role || 'user', notificationsEnabled: user.notificationsEnabled !== 0 });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('watchbot_auth');
  res.clearCookie('watchbot_restore');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.watchbot_auth;
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
  const user = db.prepare('SELECT id, username, email, createdAt, notificationsEnabled, globalEmailNotify FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, notificationsEnabled: user.notificationsEnabled !== 0, globalEmailNotify: user.globalEmailNotify !== 0 });
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
  db.transaction(() => {
    db.prepare('DELETE FROM changes WHERE trackerId IN (SELECT id FROM trackers WHERE userId = ?)').run(req.userId);
    db.prepare('DELETE FROM trackers WHERE userId = ?').run(req.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
  })();
  res.clearCookie('watchbot_auth');
  res.json({ success: true });
});

app.patch('/api/auth/profile', authMiddleware, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  if (email === undefined && newPassword === undefined && req.body.notificationsEnabled === undefined && req.body.globalEmailNotify === undefined)
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

  if (req.body.globalEmailNotify !== undefined) {
    db.prepare('UPDATE users SET globalEmailNotify = ? WHERE id = ?')
      .run(req.body.globalEmailNotify ? 1 : 0, req.userId);
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

app.get('/api/auth/email-configured', authMiddleware, (req, res) => {
  res.json({ configured: _isSesConfigured() });
});

app.post('/api/auth/test-email', authMiddleware, async (req, res) => {
  if (!_isSesConfigured())
    return res.status(503).json({ error: 'Email is not configured on this server.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);
  if (!user?.email)
    return res.status(400).json({ error: 'No email address on your account.' });

  const from    = process.env.SES_FROM || 'Watchbot <noreply@example.com>';
  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [user.email] },
    Message: {
      Subject: { Data: 'Watchbot — test email', Charset: 'UTF-8' },
      Body: {
        Text: { Data: 'This is a test email from Watchbot. Email notifications are working correctly.', Charset: 'UTF-8' },
        Html: { Data: '<p style="font-family:system-ui,sans-serif">This is a test email from <strong>Watchbot</strong>. Email notifications are working correctly.</p>', Charset: 'UTF-8' },
      },
    },
  });
  try {
    await _sesClient().send(command);
    log('✉', _c.cyan, `Test email sent → ${user.email}`);
    res.json({ success: true });
  } catch (err) {
    log('✗', _c.red, `Test email error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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
  db.transaction(() => {
    db.prepare('DELETE FROM changes WHERE trackerId IN (SELECT id FROM trackers WHERE userId = ?)').run(targetId);
    db.prepare('DELETE FROM trackers WHERE userId = ?').run(targetId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  })();

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

app.patch('/api/admin/trackers/:id', adminMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  if (req.body.active !== undefined) {
    tracker.active = !!req.body.active;
    if (!tracker.active) stopTrackerTimer(tracker.id);
    else startTrackerTimer(tracker);
  }
  saveTrackers(trackers);
  res.json({ success: true });
});

app.delete('/api/admin/trackers/:id', adminMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  stopTrackerTimer(tracker.id);
  db.prepare('DELETE FROM changes WHERE trackerId = ?').run(tracker.id);
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
  const adminToken = req.cookies.watchbot_auth;
  res.cookie('watchbot_restore', adminToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });

  const impersonateToken = jwt.sign(
    { userId: target.id, username: target.username, role: target.role || 'user',
      impersonatedBy: { id: req.userId, username: req.username } },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.cookie('watchbot_auth', impersonateToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({ id: target.id, username: target.username, role: target.role || 'user',
    notificationsEnabled: target.notificationsEnabled !== 0,
    impersonatedBy: { id: req.userId, username: req.username } });
});

app.post('/api/admin/stop-impersonate', (req, res) => {
  const restoreToken = req.cookies?.watchbot_restore;
  if (!restoreToken) return res.status(400).json({ error: 'No impersonation session to restore' });
  try {
    jwt.verify(restoreToken, JWT_SECRET);
  } catch {
    res.clearCookie('watchbot_restore');
    res.clearCookie('watchbot_auth');
    return res.status(401).json({ error: 'Restore token invalid or expired' });
  }
  res.cookie('watchbot_auth', restoreToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.clearCookie('watchbot_restore');
  const payload = jwt.decode(restoreToken);
  const user = db.prepare('SELECT role, notificationsEnabled FROM users WHERE id = ?').get(payload.userId);
  res.json({ id: payload.userId, username: payload.username, role: user?.role || 'superadmin',
    notificationsEnabled: user?.notificationsEnabled !== 0 });
});

// ─── FETCH PAGE TITLE ────────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/gi,    '&')
    .replace(/&lt;/gi,     '<')
    .replace(/&gt;/gi,     '>')
    .replace(/&quot;/gi,   '"')
    .replace(/&apos;/gi,   "'")
    .replace(/&nbsp;/gi,   ' ')
    .replace(/&ndash;/gi,  '–')
    .replace(/&mdash;/gi,  '—')
    .replace(/&lsquo;/gi,  '\u2018')
    .replace(/&rsquo;/gi,  '\u2019')
    .replace(/&ldquo;/gi,  '\u201c')
    .replace(/&rdquo;/gi,  '\u201d')
    .replace(/&hellip;/gi, '…')
    .replace(/&trade;/gi,  '™')
    .replace(/&copy;/gi,   '©')
    .replace(/&reg;/gi,    '®')
    // Decimal numeric entities e.g. &#8211; &#039;
    .replace(/&#(\d+);/g,         (_, n) => String.fromCodePoint(parseInt(n, 10)))
    // Hex numeric entities e.g. &#x2019;
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

app.get('/api/fetch-title', authMiddleware, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const { body } = await fetchResource(url);
    const match = body.match(/<title[^>]*>([\s\S]{1,400}?)<\/title>/i);
    const title = match
      ? decodeHtmlEntities(match[1].replace(/\s+/g, ' ').trim())
      : null;
    res.json({ title });
  } catch (err) {
    res.json({ title: null });
  }
});

// ─── AI RESOURCE FINDER ───────────────────────────────────────────────────────
app.post('/api/ai/find-resources', authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'query is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI features require ANTHROPIC_API_KEY to be configured on the server.' });

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `You are a web resource discovery assistant. Given a topic the user wants to monitor for updates, suggest exactly 30 real, high-quality, publicly accessible URLs that would give meaningful, ongoing updates about that topic.

Topic: "${query.trim().slice(0, 200)}"

Return ONLY a valid JSON array. No markdown fences, no explanation — just the raw JSON array.

Each item must have exactly these fields:
- "url": full HTTPS URL (must be real and publicly accessible)
- "label": short display name (e.g. "Reuters – Donald Trump")
- "description": one sentence describing what this page tracks
- "category": exactly one of: "News", "Official", "Social", "Data/API", "Blog", "Forum", "Video", "Other"

Prioritise:
- Major news sources with topic-specific tag or search pages
- Official websites or government pages where relevant
- Real-time data feeds or JSON/RSS endpoints
- High-signal social or community sources

Return exactly 30 results. Return only the JSON array, no other text.`
        }]
      },
      {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json'
        },
        timeout: 90000
      }
    );

    const rawText = response.data?.content?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'AI returned an empty response' });

    // Strip any markdown code fences Claude may have added despite instructions
    const cleaned = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();

    // Find the outermost JSON array — use indexOf/lastIndexOf instead of a
    // greedy regex so that stray brackets in any preamble text don't corrupt the slice
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd   = cleaned.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
      log('✗', _c.red, `AI finder: no JSON array found. Response preview: ${rawText.slice(0, 400)}`);
      return res.status(500).json({ error: 'AI returned an unexpected format' });
    }

    let raw;
    try {
      raw = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    } catch (parseErr) {
      log('✗', _c.red, `AI finder: JSON parse failed (${parseErr.message}). Preview: ${cleaned.slice(arrayStart, arrayStart + 400)}`);
      return res.status(500).json({ error: 'AI response could not be parsed' });
    }
    if (!Array.isArray(raw)) return res.status(500).json({ error: 'AI response was not an array' });

    const allowed = new Set(['News', 'Official', 'Social', 'Data/API', 'Blog', 'Forum', 'Video', 'Other']);
    const suggestions = raw
      .filter(s => {
        if (!s.url || typeof s.url !== 'string') return false;
        try { const u = new URL(s.url.trim()); return u.protocol === 'https:'; } catch { return false; }
      })
      .map(s => ({
        url:         s.url.trim(),
        label:       String(s.label || s.url).slice(0, 120),
        description: String(s.description || '').slice(0, 300),
        category:    allowed.has(s.category) ? s.category : 'Other'
      }))
      .slice(0, 30);

    log('✦', _c.magenta, `AI finder  "${query.trim()}"  → ${suggestions.length} suggestions`);
    res.json({ suggestions, query: query.trim() });
  } catch (err) {
    log('✗', _c.red, `AI finder error: ${err.message}`);
    res.status(500).json({ error: 'AI search failed. Please try again.' });
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
  const { url, label, interval, aiSummary, emailNotify } = req.body;
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
    emailNotify:  emailNotify === true,
    createdAt:    new Date().toISOString(),
    userId:       req.userId
  };

  trackers.unshift(tracker);
  saveTrackers(trackers);
  startTrackerTimer(tracker);
  enqueueCheck(tracker); // queue first check — respects concurrency limit

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
  db.prepare('DELETE FROM changes WHERE trackerId = ?').run(req.params.id);
  trackers = trackers.filter(t => t.id !== req.params.id);
  saveTrackers(trackers);
  res.json({ success: true });
});

app.patch('/api/trackers/:id', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  ['active', 'label', 'interval', 'aiSummary', 'emailNotify'].forEach(k => {
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
  db.prepare('UPDATE changes SET dismissed = 1 WHERE trackerId = ?').run(req.params.id);
  tracker.status        = 'ok';
  tracker.changeSummary = null;
  tracker.changeSnippet = null;
  saveTrackers(trackers);
  res.json({ success: true });
});

app.post('/api/changes/:id/dismiss', authMiddleware, (req, res) => {
  const change = db.prepare('SELECT trackerId FROM changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  const tracker = trackers.find(t => t.id === change.trackerId && t.userId === req.userId);
  if (!tracker) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE changes SET dismissed = 1 WHERE id = ?').run(req.params.id);
  // Reset tracker status when no undismissed changes remain
  const undismissed = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ? AND dismissed = 0').get(tracker.id).c;
  if (undismissed === 0) {
    tracker.status        = 'ok';
    tracker.changeSummary = null;
    tracker.changeSnippet = null;
    saveTrackers(trackers);
  }
  res.json({ success: true });
});

app.post('/api/changes/:id/lock', authMiddleware, (req, res) => {
  const change = db.prepare('SELECT trackerId, locked FROM changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  const tracker = trackers.find(t => t.id === change.trackerId && t.userId === req.userId);
  if (!tracker) return res.status(403).json({ error: 'Forbidden' });
  const newLocked = change.locked ? 0 : 1;
  db.prepare('UPDATE changes SET locked = ? WHERE id = ?').run(newLocked, req.params.id);
  tracker.lockedCount = Math.max((tracker.lockedCount || 0) + (newLocked === 1 ? 1 : -1), 0);
  _saveOneTracker(tracker);
  res.json({ locked: newLocked === 1 });
});

app.get('/api/changes', authMiddleware, (req, res) => {
  const limit          = Math.min(parseInt(req.query.limit) || 50, 200);
  const trackerId      = req.query.trackerId;
  const userTrackerIds = trackers.filter(t => t.userId === req.userId).map(t => t.id);
  if (userTrackerIds.length === 0) return res.json([]);
  // Push ownership filtering and LIMIT into SQL — avoids loading the whole table
  if (trackerId) {
    if (!userTrackerIds.includes(trackerId)) return res.json([]);
    return res.json(db.prepare(
      'SELECT * FROM changes WHERE trackerId = ? ORDER BY detectedAt DESC LIMIT ?'
    ).all(trackerId, limit));
  }
  const ph = userTrackerIds.map(() => '?').join(',');
  res.json(db.prepare(
    `SELECT * FROM changes WHERE trackerId IN (${ph}) ORDER BY detectedAt DESC LIMIT ?`
  ).all(...userTrackerIds, limit));
});

app.get('/api/trackers/:id/changes', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  const limit  = Math.min(parseInt(req.query.limit) || 5, 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const total  = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ?').get(req.params.id).c;
  const rows  = db.prepare(
    'SELECT id, detectedAt, summary, dismissed, locked, soft, snippet FROM changes WHERE trackerId = ? ORDER BY detectedAt DESC LIMIT ? OFFSET ?'
  ).all(req.params.id, limit, offset);
  const items = rows.map(r => ({ ...r, snippet: r.snippet ? JSON.parse(r.snippet) : null }));
  res.json({ items, total, offset, limit });
});

app.delete('/api/trackers/:id/changes', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM changes WHERE trackerId = ? AND locked = 0').run(req.params.id);
  const remainingLocked = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ?').get(req.params.id).c;
  tracker.changeCount = remainingLocked;
  if (remainingLocked === 0) {
    tracker.changeSummary = null;
    tracker.changeSnippet = null;
  }
  // Only reset 'changed' status if no unread, unlocked changes remain
  const stillUnread = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ? AND dismissed = 0 AND locked = 0').get(req.params.id).c;
  if (stillUnread === 0 && tracker.status === 'changed') tracker.status = 'ok';
  saveTrackers(trackers);
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const userCount   = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeCount = trackers.filter(t => t.active).length;
  console.log(`\n${_c.bold}${_c.green}🤖 Watchbot${_c.r}  listening on ${_c.cyan}http://localhost:${PORT}${_c.r}`);
  console.log(`   ${_c.dim}Database : ${DB_PATH}${_c.r}`);
  console.log(`   ${_c.dim}Users    : ${userCount}  |  Trackers : ${trackers.length} total, ${activeCount} active${_c.r}`);
  console.log(`   ${_c.dim}AI       : ${process.env.ANTHROPIC_API_KEY ? '✓ enabled' : '✗ set ANTHROPIC_API_KEY to enable'}${_c.r}\n`);
  trackers.forEach(t => { if (t.active) startTrackerTimer(t); });
});
