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
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const S3_MEDIA_BUCKET = process.env.S3_MEDIA_BUCKET || '';
const CDN_BASE_URL    = (process.env.CDN_BASE_URL || '').replace(/\/$/, '');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET || 'watchbot-fallback-secret-change-in-production';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function _normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const CORS_ALLOWLIST = (() => {
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(_normalizeOrigin)
    .filter(Boolean);

  const defaults = (process.env.NODE_ENV || 'development') !== 'production'
    ? [
        _normalizeOrigin(`http://localhost:${PORT}`),
        _normalizeOrigin(`http://127.0.0.1:${PORT}`),
      ].filter(Boolean)
    : [];

  return Array.from(new Set([...defaults, ...configured]));
})();

const _corsAllowSet = new Set(CORS_ALLOWLIST);

app.use(cors({
  credentials: true,
  origin(origin, cb) {
    // Requests without Origin are non-browser/server-to-server and are allowed.
    // Browser cross-origin requests must match the explicit allowlist.
    if (!origin) return cb(null, true);
    const normalized = _normalizeOrigin(origin);
    return cb(null, !!normalized && _corsAllowSet.has(normalized));
  },
}));
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

function gravatarUrl(email, size = 64) {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return null;
  const s = Math.min(Math.max(parseInt(size) || 64, 16), 512);
  const hash = crypto.createHash('md5').update(clean).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${s}&d=mp&r=g`;
}

const PASSWORD_POLICY = Object.freeze({
  minLength: 10,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  number: /\d/,
  symbol: /[^A-Za-z0-9]/,
});

function passwordPolicyError(password, fieldLabel = 'Password') {
  if (typeof password !== 'string' || !password.length)
    return `${fieldLabel} is required`;
  const valid =
    password.length >= PASSWORD_POLICY.minLength &&
    PASSWORD_POLICY.upper.test(password) &&
    PASSWORD_POLICY.lower.test(password) &&
    PASSWORD_POLICY.number.test(password) &&
    PASSWORD_POLICY.symbol.test(password);
  if (valid) return null;
  return `${fieldLabel} must be at least ${PASSWORD_POLICY.minLength} characters and include uppercase, lowercase, a number, and a symbol`;
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
  const rawInput = process.env.CLAUDE_MODEL || 'sonnet-4';
  const raw = rawInput.trim().toLowerCase();
  return _modelAliases[raw] || rawInput.trim();
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
try { db.exec('ALTER TABLE users ADD COLUMN hideAiFinder        INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN hideAddTracker      INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN changesMaxHeight    INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN emailVerified      INTEGER NOT NULL DEFAULT 0'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                    TEXT PRIMARY KEY,
    username              TEXT UNIQUE NOT NULL,
    passwordHash          TEXT NOT NULL,
    createdAt             TEXT NOT NULL,
    email                 TEXT,
    role                  TEXT    NOT NULL DEFAULT 'user',
    emailVerified         INTEGER NOT NULL DEFAULT 0,
    disabled              INTEGER NOT NULL DEFAULT 0,
    trackerLimit          INTEGER,
    notificationsEnabled  INTEGER NOT NULL DEFAULT 1,
    globalEmailNotify     INTEGER NOT NULL DEFAULT 1,
    hideAiFinder          INTEGER NOT NULL DEFAULT 0,
    hideAddTracker        INTEGER NOT NULL DEFAULT 0,
    changesMaxHeight      INTEGER NOT NULL DEFAULT 0,
    disableAiSummary      INTEGER NOT NULL DEFAULT 0,
    activeProfileId       TEXT
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
    emailNotify   INTEGER DEFAULT 0,
    faviconUrl    TEXT,
    profileId     TEXT
  );

  CREATE TABLE IF NOT EXISTS changes (
    id               TEXT PRIMARY KEY,
    trackerId        TEXT NOT NULL,
    trackerLabel     TEXT,
    url              TEXT,
    detectedAt       TEXT,
    summary          TEXT,
    oldHash          TEXT,
    newHash          TEXT,
    dismissed        INTEGER DEFAULT 0,
    flagged          INTEGER DEFAULT 0,
    soft             INTEGER DEFAULT 0,
    snippet          TEXT,
    aiDisabledReason TEXT
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    id        TEXT PRIMARY KEY,
    userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type      TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    expiresAt TEXT NOT NULL,
    used      INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id        TEXT PRIMARY KEY,
    userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_profiles_userId ON profiles(userId);
`);

// Migrations for existing DBs
try { db.prepare('ALTER TABLE changes ADD COLUMN dismissed INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN locked   INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN flagged  INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('UPDATE changes SET flagged = locked WHERE locked = 1 AND flagged = 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN soft      INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN snippet           TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE changes ADD COLUMN aiDisabledReason   TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE trackers ADD COLUMN emailNotify INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE trackers ADD COLUMN faviconUrl TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE trackers ADD COLUMN profileId TEXT').run(); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN disableAiSummary INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN activeProfileId TEXT'); } catch {}

// ─── STARTUP: ensure every user has a default profile ────────────────────────
// This migration runs once when upgrading from a version without profiles.
// It creates a "Default" profile for each user that has none, assigns all
// their existing trackers to it, and sets it as their active profile.
(() => {
  const usersWithoutProfiles = db.prepare(
    'SELECT id FROM users WHERE id NOT IN (SELECT DISTINCT userId FROM profiles)'
  ).all();
  const migrateUser = db.transaction((userId) => {
    const profileId = uuidv4();
    db.prepare(
      'INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 1, ?)'
    ).run(profileId, userId, 'Default', new Date().toISOString());
    db.prepare('UPDATE users SET activeProfileId = ? WHERE id = ?').run(profileId, userId);
    db.prepare(
      'UPDATE trackers SET profileId = ? WHERE userId = ? AND (profileId IS NULL OR profileId = \'\')'
    ).run(profileId, userId);
  });
  usersWithoutProfiles.forEach(u => migrateUser(u.id));
})();

// ─── SITE SETTINGS HELPERS ───────────────────────────────────────────────────
function getSetting(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

// Indexes for query performance — idempotent, safe to run on every startup
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_changes_trackerId  ON changes(trackerId);
  CREATE INDEX IF NOT EXISTS idx_changes_detectedAt ON changes(detectedAt);
  CREATE INDEX IF NOT EXISTS idx_trackers_userId    ON trackers(userId);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_type ON auth_tokens(userId, type, used);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry    ON auth_tokens(expiresAt);
`);

// Pre-compiled statements used in hot paths (parsed once, reused on every call)
const _selectUserForAuth = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?');

// ─── PROFILE HELPERS ─────────────────────────────────────────────────────────
function getUserActiveProfileId(userId) {
  const user = db.prepare('SELECT activeProfileId FROM users WHERE id = ?').get(userId);
  if (user?.activeProfileId) return user.activeProfileId;
  // Fallback: get the default profile if activeProfileId was never set
  const profile = db.prepare('SELECT id FROM profiles WHERE userId = ? AND isDefault = 1').get(userId);
  return profile?.id || null;
}

// Returns the tracker list for the user's currently active profile, with lastBody stripped.
function getActiveProfileTrackers(userId) {
  const activeProfileId = getUserActiveProfileId(userId);
  return trackers
    .filter(t => t.userId === userId && t.profileId === activeProfileId)
    .map(({ lastBody, ...rest }) => rest);
}

function rowToTracker(row) {
  return {
    ...row,
    active:        row.active      === 1,
    aiSummary:     row.aiSummary   !== 0,
    emailNotify:   row.emailNotify === 1,
    faviconUrl:    row.faviconUrl  || null,
    changeSnippet: row.changeSnippet ? JSON.parse(row.changeSnippet) : null,
    profileId:     row.profileId   || null,
  };
}

function loadTrackers() {
  const rows    = db.prepare('SELECT * FROM trackers ORDER BY position ASC').all();
  const lockMap = {};
  db.prepare('SELECT trackerId, COUNT(*) as c FROM changes WHERE flagged = 1 GROUP BY trackerId')
    .all().forEach(r => { lockMap[r.trackerId] = r.c; });
  return rows.map(row => ({ ...rowToTracker(row), flaggedCount: lockMap[row.id] || 0 }));
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
     aiSummary, createdAt, position, emailNotify, faviconUrl, profileId)
  VALUES
    (@id, @userId, @label, @url, @interval, @active, @status, @lastCheck, @lastHash,
     @lastBody, @httpStatus, @changeCount, @changeSummary, @changeSnippet, @error,
     @aiSummary, @createdAt, @position, @emailNotify, @faviconUrl, @profileId)
  ON CONFLICT(id) DO UPDATE SET
    label=excluded.label, url=excluded.url, interval=excluded.interval,
    active=excluded.active, status=excluded.status, lastCheck=excluded.lastCheck,
    lastHash=excluded.lastHash, lastBody=excluded.lastBody, httpStatus=excluded.httpStatus,
    changeCount=excluded.changeCount, changeSummary=excluded.changeSummary,
    changeSnippet=excluded.changeSnippet, error=excluded.error,
    aiSummary=excluded.aiSummary, position=excluded.position, emailNotify=excluded.emailNotify,
    faviconUrl=excluded.faviconUrl, profileId=excluded.profileId
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

  // SSE broadcast per-user, strip lastBody — only send trackers for the user's active profile
  const affectedUserIds = new Set(list.map(t => t.userId).filter(Boolean));
  affectedUserIds.forEach(userId => {
    broadcastToUser({ type: 'update', trackers: getActiveProfileTrackers(userId) }, userId);
  });
  // Notify users who lost all their trackers (clears stale tracker lists in other tabs)
  emptyUserIds.forEach(uid => broadcastToUser({ type: 'update', trackers: getActiveProfileTrackers(uid) }, uid));
}

// Lightweight single-tracker save used during check cycles.
// Upserts only one row and broadcasts only to that user — avoids re-writing
// every tracker and running orphan-cleanup queries on each check.
function _saveOneTracker(tracker) {
  const position = trackers.findIndex(t => t.id === tracker.id);
  _upsertTracker.run({
    ...tracker,
    active:        tracker.active       ? 1 : 0,
    aiSummary:     tracker.aiSummary === false ? 0 : 1,
    emailNotify:   tracker.emailNotify  ? 1 : 0,
    changeSnippet: tracker.changeSnippet ? JSON.stringify(tracker.changeSnippet) : null,
    position:      position >= 0 ? position : 0,
  });
  // Only broadcast trackers belonging to the user's currently active profile
  broadcastToUser(
    { type: 'update', trackers: getActiveProfileTrackers(tracker.userId) },
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
    INSERT INTO changes (id, trackerId, trackerLabel, url, detectedAt, summary, oldHash, newHash, dismissed, soft, snippet, aiDisabledReason)
    VALUES (@id, @trackerId, @trackerLabel, @url, @detectedAt, @summary, @oldHash, @newHash, @dismissed, @soft, @snippet, @aiDisabledReason)
  `).run({ dismissed: 0, soft: 0, snippet: null, aiDisabledReason: null, ...change, snippet: snippetJson });
  // Only prune when the unflagged pool actually exceeds the cap — avoids a
  // redundant DELETE subquery scan on every save when well under the limit.
  const cap = Math.max(parseInt(getSetting('historyRetentionCap', '500') || '500'), 10);
  const { c } = db.prepare('SELECT COUNT(*) as c FROM changes WHERE flagged = 0').get();
  if (c > cap) {
    db.prepare(`
      DELETE FROM changes WHERE flagged = 0 AND id NOT IN (
        SELECT id FROM changes WHERE flagged = 0 ORDER BY detectedAt DESC LIMIT ${cap}
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

// ─── SEED ADMIN ─────────────────────────────────────────────────────────────
(async () => {
  const existingDefault = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get('admin');
  const hasAdminRole = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (!hasAdminRole) {
    if (existingDefault) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', existingDefault.id);
      log('✓', _c.green, 'Existing "admin" user promoted to admin role');
      // Ensure promoted admin has a default profile
      const hasProfile = db.prepare('SELECT id FROM profiles WHERE userId = ?').get(existingDefault.id);
      if (!hasProfile) {
        const pid = uuidv4();
        db.prepare('INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 1, ?)')
          .run(pid, existingDefault.id, 'Default', new Date().toISOString());
        db.prepare('UPDATE users SET activeProfileId = ? WHERE id = ?').run(pid, existingDefault.id);
      }
    } else {
      const adminId = uuidv4();
      const profileId = uuidv4();
      const now = new Date().toISOString();
      const hash = await bcrypt.hash('Watchbot@2025!', 12);
      db.transaction(() => {
        db.prepare(`INSERT INTO users (id, username, passwordHash, createdAt, role, activeProfileId)
                    VALUES (?, 'admin', ?, ?, 'admin', ?)`).
          run(adminId, hash, now, profileId);
        db.prepare('INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 1, ?)')
          .run(profileId, adminId, 'Default', now);
      })();
      log('✓', _c.green, 'Admin account created (admin)');
    }
  }
})();

// ─── EMAIL (AWS SES API) ─────────────────────────────────────────────────────
function _isSesConfigured() {
  return !!(process.env.SES_REGION && process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY);
}

function _sesClient() {
  return new SESClient({
    region: process.env.SES_REGION,
    credentials: {
      accessKeyId:     process.env.SES_ACCESS_KEY_ID,
      secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
    },
  });
}

const AUTH_TOKEN_TYPE_VERIFY_EMAIL = 'verify_email';
const AUTH_TOKEN_TYPE_PASSWORD_RESET = 'password_reset';
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

function _hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function _pruneAuthTokens() {
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM auth_tokens WHERE used = 1 OR expiresAt < ?').run(nowIso);
}

function _createAuthToken(userId, type, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(`
    INSERT INTO auth_tokens (id, userId, type, tokenHash, expiresAt, used, createdAt)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(uuidv4(), userId, type, _hashToken(raw), expiresAt, now.toISOString());
  _pruneAuthTokens();
  return raw;
}

function _consumeAuthToken(type, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const row = db.prepare(`
    SELECT id, userId, expiresAt
    FROM auth_tokens
    WHERE type = ? AND tokenHash = ? AND used = 0
  `).get(type, _hashToken(token));
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
    return null;
  }
  db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
  return row;
}

function _invalidateAuthTokens(userId, type) {
  db.prepare('UPDATE auth_tokens SET used = 1 WHERE userId = ? AND type = ?').run(userId, type);
}

function _authBaseUrl(req) {
  const envBase = (process.env.APP_BASE_URL || '').trim();
  if (envBase) return envBase.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function _authActionLink(req, action, token) {
  return `${_authBaseUrl(req)}/?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}`;
}

async function _sendAccountEmail(toEmail, subject, textBody, htmlBody) {
  const from = process.env.SES_FROM || 'Watchbot <noreply@example.com>';
  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
        Text: { Data: textBody, Charset: 'UTF-8' },
      },
    },
  });
  await _sesClient().send(command);
}

async function sendEmailVerificationEmail(user, req) {
  if (!_isSesConfigured() || !user?.email) return false;
  _invalidateAuthTokens(user.id, AUTH_TOKEN_TYPE_VERIFY_EMAIL);
  const token = _createAuthToken(user.id, AUTH_TOKEN_TYPE_VERIFY_EMAIL, EMAIL_VERIFY_TTL_MS);
  const verifyLink = _authActionLink(req, 'verify-email', token);
  const displayName = (user.username || 'there').replace(/</g, '&lt;');
  const textBody = `Watchbot — Verify your email\n\nHi ${user.username || 'there'},\n\nPlease verify your Watchbot email by opening this link:\n${verifyLink}\n\nThis link expires in 24 hours.`;
  const htmlBody = `
<div style="font-family:'DM Sans',system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#202124">
  <div style="background:#1a73e8;padding:20px 24px;border-radius:12px 12px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:500">Verify your <strong style="font-weight:700">Watchbot</strong> email</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 8px;font-size:15px">Hi ${displayName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#5f6368">Confirm your email address to keep your account secure and fully enabled.</p>
    <p style="margin:0 0 18px"><a href="${verifyLink}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Verify email</a></p>
    <p style="margin:0 0 8px;font-size:12px;color:#9aa0a6">Or paste this link into your browser:</p>
    <p style="margin:0;font-size:12px;word-break:break-all;color:#5f6368">${verifyLink}</p>
    <p style="margin:16px 0 0;font-size:12px;color:#9aa0a6">This link expires in 24 hours.</p>
  </div>
</div>`;
  try {
    await _sendAccountEmail(user.email, 'Watchbot — verify your email', textBody, htmlBody);
    log('✉', _c.cyan, `Verification email sent → ${user.email}`);
    return true;
  } catch (err) {
    log('✗', _c.red, `Verification email error: ${err.message}`);
    return false;
  }
}

async function sendPasswordResetEmail(user, req) {
  if (!_isSesConfigured() || !user?.email) return false;
  _invalidateAuthTokens(user.id, AUTH_TOKEN_TYPE_PASSWORD_RESET);
  const token = _createAuthToken(user.id, AUTH_TOKEN_TYPE_PASSWORD_RESET, PASSWORD_RESET_TTL_MS);
  const resetLink = _authActionLink(req, 'reset-password', token);
  const displayName = (user.username || 'there').replace(/</g, '&lt;');
  const textBody = `Watchbot — Reset password\n\nHi ${user.username || 'there'},\n\nUse this secure link to reset your password:\n${resetLink}\n\nThis link expires in 30 minutes. If you did not request this, you can ignore this email.`;
  const htmlBody = `
<div style="font-family:'DM Sans',system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#202124">
  <div style="background:#1a73e8;padding:20px 24px;border-radius:12px 12px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:500">Reset your <strong style="font-weight:700">Watchbot</strong> password</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 8px;font-size:15px">Hi ${displayName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#5f6368">A password reset was requested for your account.</p>
    <p style="margin:0 0 18px"><a href="${resetLink}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Reset password</a></p>
    <p style="margin:0 0 8px;font-size:12px;color:#9aa0a6">Or paste this link into your browser:</p>
    <p style="margin:0;font-size:12px;word-break:break-all;color:#5f6368">${resetLink}</p>
    <p style="margin:16px 0 0;font-size:12px;color:#9aa0a6">This link expires in 30 minutes. If you did not request it, you can ignore this message.</p>
  </div>
</div>`;
  try {
    await _sendAccountEmail(user.email, 'Watchbot — password reset', textBody, htmlBody);
    log('✉', _c.cyan, `Password reset email sent → ${user.email}`);
    return true;
  } catch (err) {
    log('✗', _c.red, `Password reset email error: ${err.message}`);
    return false;
  }
}

async function sendChangeEmail(tracker, summary, owner) {
  if (!_isSesConfigured()) return;
  const from    = process.env.SES_FROM || 'Watchbot <noreply@example.com>';
  const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const html = `
<div style="font-family:'DM Sans',system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#202124">
  <div style="background:#1a73e8;padding:20px 24px;border-radius:12px 12px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:500">&#128276; Watch<strong style="font-weight:700">bot</strong> &mdash; Change Detected</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:#202124">${tracker.label.replace(/</g,'&lt;')}</p>
    <p style="margin:0 0 20px;font-size:13px;color:#5f6368"><a href="${tracker.url}" style="color:#1a73e8;text-decoration:none">${tracker.url.replace(/</g,'&lt;')}</a></p>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#202124">Summary</p>
    <div style="background:#f1f3f4;padding:12px 16px;border-radius:8px;border-left:3px solid #1a73e8;font-size:14px;line-height:1.6;color:#202124">${summary.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>
    <p style="margin:16px 0 0;font-size:12px;color:#9aa0a6">Detected at ${dateStr}</p>
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

// ─── FAVICON ──────────────────────────────────────────────────────────────────
const _s3 = S3_MEDIA_BUCKET
  ? new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? {
        credentials: {
          accessKeyId:     process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      } : {}),
    })
  : null;

// In-memory cache so re-launching the server avoids redundant S3 HEAD calls.
const _faviconDomainCache = {};

async function fetchAndStoreFavicon(trackerUrl) {
  // S3 upload is optional — requires S3_MEDIA_BUCKET + credentials to be configured.
  // Favicons are served directly by the browser in the meantime.
  if (!_s3 || !CDN_BASE_URL || !process.env.S3_ACCESS_KEY_ID) return null;

  let origin, hostname;
  try {
    const parsed = new URL(trackerUrl);
    origin   = parsed.origin;   // e.g. "https://example.com"
    hostname = parsed.hostname; // e.g. "example.com"
  } catch { return null; }

  if (_faviconDomainCache[hostname]) return _faviconDomainCache[hostname];

  const s3Key = `favicons/${hostname}.ico`;

  // Check if already stored in S3
  try {
    await _s3.send(new HeadObjectCommand({ Bucket: S3_MEDIA_BUCKET, Key: s3Key }));
    const cdnUrl = `${CDN_BASE_URL}/${s3Key}`;
    _faviconDomainCache[hostname] = cdnUrl;
    return cdnUrl;
  } catch (e) {
    if (e.name !== 'NotFound' && e.$metadata?.httpStatusCode !== 404) {
      log('~', _c.dim, `Favicon S3 HEAD error for ${hostname}: ${e.message}`);
    }
  }

  // Try fetching /favicon.ico directly
  let iconBuf = null;
  let contentType = 'image/x-icon';
  try {
    const r = await axios.get(`${origin}/favicon.ico`,
      { responseType: 'arraybuffer', timeout: 5000, validateStatus: s => s === 200 });
    if (r.data?.byteLength > 0) {
      iconBuf = Buffer.from(r.data);
      contentType = r.headers['content-type']?.split(';')[0] || 'image/x-icon';
    }
  } catch {}

  // Fallback: parse <link rel="icon"> from the page HTML
  if (!iconBuf) {
    try {
      const r = await axios.get(trackerUrl,
        { responseType: 'text', timeout: 8000, validateStatus: s => s === 200 });
      const match = r.data.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)
                 || r.data.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
      if (match) {
        const iconHref = new URL(match[1], origin).href;
        const ir = await axios.get(iconHref,
          { responseType: 'arraybuffer', timeout: 5000, validateStatus: s => s === 200 });
        if (ir.data?.byteLength > 0) {
          iconBuf = Buffer.from(ir.data);
          contentType = ir.headers['content-type']?.split(';')[0] || 'image/x-icon';
        }
      }
    } catch {}
  }

  if (!iconBuf) return null;

  // Upload to S3
  try {
    await _s3.send(new PutObjectCommand({
      Bucket:      S3_MEDIA_BUCKET,
      Key:         s3Key,
      Body:        iconBuf,
      ContentType: contentType,
      CacheControl: 'public, max-age=604800',
    }));
    const cdnUrl = `${CDN_BASE_URL}/${s3Key}`;
    _faviconDomainCache[hostname] = cdnUrl;
    log('✓', _c.green, `Favicon stored  ${hostname}  →  ${cdnUrl}`);
    return cdnUrl;
  } catch (e) {
    log('~', _c.dim, `Favicon S3 PUT error for ${hostname}: ${e.message}`);
    return null;
  }
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

      const ownerPrefs = db.prepare(
        'SELECT disableAiSummary, email, globalEmailNotify FROM users WHERE id = ?'
      ).get(tracker.userId);

      let summary;
      let aiDisabledReason = null;
      let aiLogDetail = '';
      if (preflightSoft) {
        summary = 'No significant content changes detected.';
        aiLogDetail = 'AI skipped (minor text diff preflight)';
      } else if (getSetting('aiEnabled', '1') === '0') {
        summary = 'Content changed.';
        aiDisabledReason = 'admin';
        aiLogDetail = 'AI skipped (disabled by Admin setting)';
      } else {
        if (ownerPrefs?.disableAiSummary === 1) {
          summary = 'Content changed.';
          aiDisabledReason = 'user';
          aiLogDetail = 'AI skipped (disabled by User profile)';
        } else if (tracker.aiSummary === false) {
          summary = 'Content changed.';
          aiDisabledReason = 'tracker';
          aiLogDetail = 'AI skipped (disabled for this tracker)';
        } else {
          aiLogDetail = 'AI requested';
          summary = await getChangeSummary(tracker.lastBody, structuredText, tracker.url);
        }
      }

      log('⚡', _c.yellow, `Changed   "${tracker.label}"  [HTTP ${status}]  — ${aiLogDetail}`);

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
        aiDisabledReason,
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
        if (ownerPrefs?.email && ownerPrefs.globalEmailNotify !== 0) {
          sendChangeEmail(tracker, summary, ownerPrefs).catch(err =>
            log('✗', _c.red, `Email error "${tracker.label}": ${err.message}`)
          );
        }
      }

    } else {
      // Only move back to 'ok' if there are no unread (undismissed, unflagged)
      // changes waiting for the user — otherwise a routine no-change check
      // would silently reset the 'changed' status and break the 'New only' filter.
      const undismissed = db.prepare(
        'SELECT COUNT(*) as c FROM changes WHERE trackerId = ? AND dismissed = 0'
      ).get(tracker.id).c;
      tracker.status = undismissed > 0 ? 'changed' : 'ok';
      log('·', _c.dim, `No changes found "${tracker.label}"  [HTTP ${status}]${undismissed > 0 ? '  — unread changes still pending' : ''}`);
    }

  } catch (err) {
    tracker.status    = 'error';
    tracker.lastCheck = now;
    tracker.error     = err.message;
    log('✗', _c.red, `Error     "${tracker.label}"  — ${err.message}`);
  }

  // Lazy favicon fetch — non-blocking; only runs once per domain
  if (!tracker.faviconUrl) {
    fetchAndStoreFavicon(tracker.url).then(cdnUrl => {
      if (cdnUrl) {
        tracker.faviconUrl = cdnUrl;
        _saveOneTracker(tracker);
      }
    }).catch(() => {});
  }

  _saveOneTracker(tracker);
  return tracker;
}

// ─── USER INTERVAL OPTIONS ───────────────────────────────────────────────────
// Default allowed intervals for non-admin users (matches former MIN_INTERVAL_USER
// behaviour — hour and above). Admin can change this via the Settings panel.
const _DEFAULT_USER_INTERVAL_OPTIONS = [3600000, 14400000, 21600000, 43200000, 86400000, 259200000, 604800000];

function getUserAllowedIntervals() {
  const stored = getSetting('userIntervalOptions', null);
  if (!stored) return _DEFAULT_USER_INTERVAL_OPTIONS;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(Number);
  } catch {}
  return _DEFAULT_USER_INTERVAL_OPTIONS;
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

  const userTrackers = getActiveProfileTrackers(req.userId);
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
    req.role     = user.role || 'user';
    if (getSetting('maintenanceMode', '0') === '1' && req.role !== 'admin') {
      return res.status(503).json({ error: 'The site is currently undergoing maintenance. Please try again later.' });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ─── PUBLIC SETTINGS ENDPOINT ──────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    allowRegistration:   getSetting('allowRegistration', '1') !== '0',
    maintenanceMode:     getSetting('maintenanceMode',   '0') === '1',
    userIntervalOptions: getUserAllowedIntervals(),
  });
});

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  if (getSetting('allowRegistration', '1') === '0')
    return res.status(403).json({ error: 'Registration is currently disabled.' });
  const { username, password, email } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (!email?.trim())
    return res.status(400).json({ error: 'Email address is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: 'Please enter a valid email address' });
  if (username.trim().length < 2)
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  const registerPwError = passwordPolicyError(password, 'Password');
  if (registerPwError)
    return res.status(400).json({ error: registerPwError });

  const existingUsername = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
  if (existingUsername) return res.status(409).json({ error: 'That username is already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const initLimit = (() => {
    const g = parseInt(getSetting('defaultTrackerLimit', '0') || '0');
    return g > 0 ? g : null;
  })();
  const user = { id: uuidv4(), username: username.trim(), email: email.trim().toLowerCase(), passwordHash, createdAt: new Date().toISOString(), emailVerified: 0 };
  const defaultProfileId = uuidv4();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, username, email, passwordHash, createdAt, trackerLimit, emailVerified, activeProfileId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.username, user.email, user.passwordHash, user.createdAt, initLimit, user.emailVerified, defaultProfileId);
    db.prepare('INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 1, ?)')
      .run(defaultProfileId, user.id, 'Default', user.createdAt);
  })();

  const verificationEmailSent = await sendEmailVerificationEmail(user, req);

  const token = jwt.sign({ userId: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchbot_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.status(201).json({
    id: user.id,
    username: user.username,
    role: 'user',
    notificationsEnabled: true,
    hideAiFinder: false,
    hideAddTracker: false,
    changesMaxHeight: 0,
    trackerLimit: initLimit,
    disableAiSummary: false,
    emailVerified: false,
    verificationEmailSent,
    gravatarUrl: gravatarUrl(user.email, 64),
    activeProfileId: defaultProfileId,
  });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const generic = 'If an account exists for that email, a reset link has been sent.';
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ success: true, message: generic });
  }

  const user = db.prepare('SELECT id, username, email, disabled FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (!user || user.disabled) {
    return res.json({ success: true, message: generic });
  }

  if (!_isSesConfigured()) {
    log('~', _c.dim, `Password reset requested for ${email}, but SES is not configured.`);
    return res.json({ success: true, message: generic });
  }

  await sendPasswordResetEmail(user, req);
  return res.json({ success: true, message: generic });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = req.body?.token;
  const newPassword = req.body?.newPassword;
  const newPwError = passwordPolicyError(newPassword, 'New password');
  if (newPwError) return res.status(400).json({ error: newPwError });

  const consumed = _consumeAuthToken(AUTH_TOKEN_TYPE_PASSWORD_RESET, token);
  if (!consumed) {
    return res.status(400).json({ error: 'Reset link is invalid or has expired.' });
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(consumed.userId);
  if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired.' });

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET passwordHash = ?, emailVerified = 1 WHERE id = ?').run(hash, consumed.userId);
  _invalidateAuthTokens(consumed.userId, AUTH_TOKEN_TYPE_PASSWORD_RESET);
  _invalidateAuthTokens(consumed.userId, AUTH_TOKEN_TYPE_VERIFY_EMAIL);
  res.json({ success: true });
});

app.post('/api/auth/verify-email', (req, res) => {
  const token = req.body?.token;
  const consumed = _consumeAuthToken(AUTH_TOKEN_TYPE_VERIFY_EMAIL, token);
  if (!consumed) {
    return res.status(400).json({ error: 'Verification link is invalid or has expired.' });
  }
  db.prepare('UPDATE users SET emailVerified = 1 WHERE id = ?').run(consumed.userId);
  _invalidateAuthTokens(consumed.userId, AUTH_TOKEN_TYPE_VERIFY_EMAIL);
  res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
  const identifierRaw = req.body?.identifier ?? req.body?.username ?? req.body?.email;
  const identifier = typeof identifierRaw === 'string' ? identifierRaw.trim() : '';
  const password = req.body?.password;
  if (!identifier || !password)
    return res.status(400).json({ error: 'Email or username and password are required' });

  const lookup = identifier.toLowerCase();
  const preferEmail = identifier.includes('@');
  const user = preferEmail
    ? db.prepare(`
        SELECT * FROM users
        WHERE LOWER(email) = ? OR LOWER(username) = ?
        ORDER BY CASE WHEN LOWER(email) = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(lookup, lookup, lookup)
    : db.prepare(`
        SELECT * FROM users
        WHERE LOWER(username) = ? OR LOWER(email) = ?
        ORDER BY CASE WHEN LOWER(username) = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(lookup, lookup, lookup);
  if (!user) return res.status(401).json({ error: 'Invalid email/username or password' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email/username or password' });

  if (user.disabled) return res.status(403).json({ error: 'Your account has been deactivated. Please contact an administrator.' });

  const token = jwt.sign({ userId: user.id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('watchbot_auth', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.json({
    id: user.id,
    username: user.username,
    role: user.role || 'user',
    notificationsEnabled: user.notificationsEnabled !== 0,
    hideAiFinder: user.hideAiFinder === 1,
    hideAddTracker: user.hideAddTracker === 1,
    changesMaxHeight: user.changesMaxHeight || 0,
    trackerLimit: user.trackerLimit ?? null,
    disableAiSummary: user.disableAiSummary === 1,
    emailVerified: user.emailVerified === 1,
    gravatarUrl: gravatarUrl(user.email, 64),
    activeProfileId: user.activeProfileId || null,
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('watchbot_auth');
  res.clearCookie('watchbot_restore');
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.watchbot_auth;
  if (!token) {
    // No session — still check maintenance so unauthenticated visitors get 503
    if (getSetting('maintenanceMode', '0') === '1')
      return res.status(503).json({ error: 'System maintenance in progress.' });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT username, role, email, emailVerified, disabled, notificationsEnabled, hideAiFinder, hideAddTracker, changesMaxHeight, trackerLimit, disableAiSummary, activeProfileId FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.disabled) return res.status(401).json({ error: 'Not authenticated' });
    const role = user.role || 'user';
    if (getSetting('maintenanceMode', '0') === '1' && role !== 'admin')
      return res.status(503).json({ error: 'System maintenance in progress.' });
    res.json({ id: payload.userId, username: user.username || payload.username, role,
      notificationsEnabled: user.notificationsEnabled !== 0,
      hideAiFinder:         user.hideAiFinder  === 1,
      hideAddTracker:       user.hideAddTracker === 1,
      changesMaxHeight:     user.changesMaxHeight || 0,
      trackerLimit:         user.trackerLimit ?? null,
      disableAiSummary:     user.disableAiSummary === 1,
        emailVerified:        user.emailVerified === 1,
      gravatarUrl:          gravatarUrl(user.email, 64),
      activeProfileId:      user.activeProfileId || null,
      ...(payload.impersonatedBy ? { impersonatedBy: payload.impersonatedBy } : {}) });
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

app.get('/api/auth/profile', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, emailVerified, createdAt, notificationsEnabled, globalEmailNotify, hideAiFinder, hideAddTracker, changesMaxHeight, disableAiSummary, activeProfileId FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...user,
    emailVerified:        user.emailVerified === 1,
    notificationsEnabled: user.notificationsEnabled !== 0,
    globalEmailNotify:    user.globalEmailNotify    !== 0,
    hideAiFinder:         user.hideAiFinder         === 1,
    hideAddTracker:       user.hideAddTracker        === 1,
    changesMaxHeight:     user.changesMaxHeight      || 0,
    disableAiSummary:     user.disableAiSummary      === 1,
    activeProfileId:      user.activeProfileId       || null,
    gravatarUrl:          gravatarUrl(user.email, 96),
  });
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
  const { email, newPassword } = req.body;
  let emailChanged = false;
  const pending = {};
  let nextPasswordHash = null;

  if (email === undefined && newPassword === undefined && req.body.username === undefined && req.body.notificationsEnabled === undefined && req.body.globalEmailNotify === undefined && req.body.hideAiFinder === undefined && req.body.hideAddTracker === undefined && req.body.changesMaxHeight === undefined && req.body.disableAiSummary === undefined)
    return res.status(400).json({ error: 'Nothing to update' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (email !== undefined) {
    const trimmed = (email || '').trim();
    if (!trimmed)
      return res.status(400).json({ error: 'Email address is required' });
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      return res.status(400).json({ error: 'Invalid email address' });
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, req.userId);
    if (conflict) return res.status(409).json({ error: 'An account with that email already exists' });
    pending.email = trimmed.toLowerCase();
    emailChanged = true;
  }

  if (req.body.username !== undefined) {
    const trimmedUsername = String(req.body.username || '').trim();
    if (trimmedUsername.length < 2)
      return res.status(400).json({ error: 'Username must be at least 2 characters' });
    const usernameConflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(trimmedUsername, req.userId);
    if (usernameConflict) return res.status(409).json({ error: 'That username is already taken' });
    pending.username = trimmedUsername;
  }

  if (req.body.notificationsEnabled !== undefined) {
    pending.notificationsEnabled = req.body.notificationsEnabled ? 1 : 0;
  }

  if (req.body.globalEmailNotify !== undefined) {
    pending.globalEmailNotify = req.body.globalEmailNotify ? 1 : 0;
  }

  if (req.body.hideAiFinder !== undefined) {
    pending.hideAiFinder = req.body.hideAiFinder ? 1 : 0;
  }

  if (req.body.hideAddTracker !== undefined) {
    pending.hideAddTracker = req.body.hideAddTracker ? 1 : 0;
  }

  if (req.body.changesMaxHeight !== undefined) {
    const h = parseInt(req.body.changesMaxHeight) || 0;
    pending.changesMaxHeight = h >= 100 ? h : 0;
  }

  if (req.body.disableAiSummary !== undefined) {
    pending.disableAiSummary = req.body.disableAiSummary ? 1 : 0;
  }

  if (newPassword !== undefined) {
    const newPwError = passwordPolicyError(newPassword, 'New password');
    if (newPwError)
      return res.status(400).json({ error: newPwError });
    nextPasswordHash = await bcrypt.hash(newPassword, 12);
  }

  try {
    db.transaction(() => {
      if (pending.email !== undefined) {
        db.prepare('UPDATE users SET email = ?, emailVerified = 0 WHERE id = ?').run(pending.email, req.userId);
      }
      if (pending.username !== undefined) {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(pending.username, req.userId);
      }
      if (pending.notificationsEnabled !== undefined) {
        db.prepare('UPDATE users SET notificationsEnabled = ? WHERE id = ?').run(pending.notificationsEnabled, req.userId);
      }
      if (pending.globalEmailNotify !== undefined) {
        db.prepare('UPDATE users SET globalEmailNotify = ? WHERE id = ?').run(pending.globalEmailNotify, req.userId);
      }
      if (pending.hideAiFinder !== undefined) {
        db.prepare('UPDATE users SET hideAiFinder = ? WHERE id = ?').run(pending.hideAiFinder, req.userId);
      }
      if (pending.hideAddTracker !== undefined) {
        db.prepare('UPDATE users SET hideAddTracker = ? WHERE id = ?').run(pending.hideAddTracker, req.userId);
      }
      if (pending.changesMaxHeight !== undefined) {
        db.prepare('UPDATE users SET changesMaxHeight = ? WHERE id = ?').run(pending.changesMaxHeight, req.userId);
      }
      if (pending.disableAiSummary !== undefined) {
        db.prepare('UPDATE users SET disableAiSummary = ? WHERE id = ?').run(pending.disableAiSummary, req.userId);
      }
      if (nextPasswordHash !== null) {
        db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(nextPasswordHash, req.userId);
      }
    })();
  } catch (err) {
    if (/UNIQUE constraint failed: users\.email/i.test(err.message || '')) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    if (/UNIQUE constraint failed: users\.username/i.test(err.message || '')) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    log('✗', _c.red, `Profile update failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  let verificationEmailSent = false;
  if (emailChanged && _isSesConfigured()) {
    const verifyUser = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.userId);
    verificationEmailSent = await sendEmailVerificationEmail(verifyUser, req);
  }

  const updated = db.prepare('SELECT username, email, emailVerified FROM users WHERE id = ?').get(req.userId);
  res.json({
    success: true,
    username: updated?.username || null,
    email: updated?.email || null,
    emailVerified: updated?.emailVerified === 1,
    verificationEmailSent,
    gravatarUrl: gravatarUrl(updated?.email, 96),
  });
});

app.get('/api/auth/email-configured', authMiddleware, (req, res) => {
  res.json({ configured: _isSesConfigured() });
});

app.post('/api/auth/resend-verification', authMiddleware, async (req, res) => {
  const user = db.prepare('SELECT id, username, email, emailVerified FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.email) return res.status(400).json({ error: 'No email address on your account.' });
  if (user.emailVerified === 1) return res.json({ success: true, alreadyVerified: true });
  if (!_isSesConfigured()) return res.status(503).json({ error: 'Email is not configured on this server.' });

  const sent = await sendEmailVerificationEmail(user, req);
  if (!sent) return res.status(500).json({ error: 'Failed to send verification email.' });
  res.json({ success: true, sent: true });
});

app.post('/api/auth/test-email', authMiddleware, async (req, res) => {
  if (!_isSesConfigured())
    return res.status(503).json({ error: 'Email is not configured on this server.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);
  if (!user?.email)
    return res.status(400).json({ error: 'No email address on your account.' });

  const plain   = req.body?.plain === true;
  const from    = process.env.SES_FROM || 'Watchbot <noreply@example.com>';
  const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const textBody = `Watchbot — Test Email\n\nThis is a test notification from Watchbot.\nEmail notifications are working correctly.\n\nSent at ${dateStr}`;
  const htmlBody = `
<div style="font-family:'DM Sans',system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#202124">
  <div style="background:#1a73e8;padding:20px 24px;border-radius:12px 12px 0 0">
    <span style="color:#fff;font-size:18px;font-weight:500">&#128276; Watch<strong style="font-weight:700">bot</strong> &mdash; Test Email</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:#202124">Email notifications are working!</p>
    <p style="margin:0 0 20px;font-size:13px;color:#5f6368">This is a test notification sent from your Watchbot account settings.</p>
    <div style="background:#f1f3f4;padding:12px 16px;border-radius:8px;border-left:3px solid #1a73e8;font-size:14px;line-height:1.6;color:#202124">If you received this email, your notification settings are correctly configured. You will receive an email like this whenever a tracked resource changes.</div>
    <p style="margin:16px 0 0;font-size:12px;color:#9aa0a6">Sent at ${dateStr}</p>
  </div>
</div>`;

  const bodyPayload = plain
    ? { Text: { Data: textBody, Charset: 'UTF-8' } }
    : { Html: { Data: htmlBody, Charset: 'UTF-8' }, Text: { Data: textBody, Charset: 'UTF-8' } };

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [user.email] },
    Message: {
      Subject: { Data: 'Watchbot — test email', Charset: 'UTF-8' },
      Body: bodyPayload,
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

// ─── PROFILES ROUTES ─────────────────────────────────────────────────────────
const MAX_PROFILES = 10;

app.get('/api/profiles', authMiddleware, (req, res) => {
  const profiles = db.prepare(
    'SELECT id, userId, name, isDefault, createdAt FROM profiles WHERE userId = ? ORDER BY createdAt ASC'
  ).all(req.userId);
  res.json(profiles.map(p => ({ ...p, isDefault: p.isDefault === 1 })));
});

app.post('/api/profiles', authMiddleware, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Profile name is required' });
  if (name.length > 50) return res.status(400).json({ error: 'Profile name must be 50 characters or fewer' });
  const count = db.prepare('SELECT COUNT(*) as c FROM profiles WHERE userId = ?').get(req.userId).c;
  if (count >= MAX_PROFILES)
    return res.status(400).json({ error: `Maximum ${MAX_PROFILES} profiles allowed` });
  const profile = {
    id: uuidv4(),
    userId: req.userId,
    name,
    isDefault: 0,
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 0, ?)')
    .run(profile.id, profile.userId, profile.name, profile.createdAt);
  res.status(201).json({ ...profile, isDefault: false });
});

app.patch('/api/profiles/:id', authMiddleware, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND userId = ?').get(req.params.id, req.userId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.isDefault === 1) return res.status(400).json({ error: 'Cannot rename the default profile' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Profile name is required' });
  if (name.length > 50) return res.status(400).json({ error: 'Profile name must be 50 characters or fewer' });
  db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, profile.id);
  res.json({ ...profile, name, isDefault: false });
});

app.delete('/api/profiles/:id', authMiddleware, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND userId = ?').get(req.params.id, req.userId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.isDefault === 1) return res.status(400).json({ error: 'Cannot delete the default profile' });

  const defaultProfile = db.prepare('SELECT id FROM profiles WHERE userId = ? AND isDefault = 1').get(req.userId);
  const fallbackId = defaultProfile?.id || null;

  db.transaction(() => {
    // Move all in-memory trackers from deleted profile to the default profile
    trackers.forEach(t => {
      if (t.userId === req.userId && t.profileId === profile.id) {
        t.profileId = fallbackId;
      }
    });
    if (fallbackId) {
      db.prepare('UPDATE trackers SET profileId = ? WHERE userId = ? AND profileId = ?')
        .run(fallbackId, req.userId, profile.id);
    }
    // If user was on the deleted profile, switch to default
    const user = db.prepare('SELECT activeProfileId FROM users WHERE id = ?').get(req.userId);
    if (user.activeProfileId === profile.id) {
      db.prepare('UPDATE users SET activeProfileId = ? WHERE id = ?').run(fallbackId, req.userId);
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
  })();

  // Broadcast updated tracker list (uses new activeProfileId from DB)
  const profileTrackers = getActiveProfileTrackers(req.userId);
  broadcastToUser({ type: 'profile-switch', trackers: profileTrackers, activeProfileId: fallbackId }, req.userId);

  res.json({ success: true, activeProfileId: fallbackId });
});

app.post('/api/profiles/:id/switch', authMiddleware, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND userId = ?').get(req.params.id, req.userId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  db.prepare('UPDATE users SET activeProfileId = ? WHERE id = ?').run(profile.id, req.userId);

  // Broadcast new tracker list for the switched-to profile to all the user's SSE connections
  const profileTrackers = trackers
    .filter(t => t.userId === req.userId && t.profileId === profile.id)
    .map(({ lastBody, ...rest }) => rest);
  broadcastToUser({ type: 'profile-switch', trackers: profileTrackers, activeProfileId: profile.id }, req.userId);

  res.json({ success: true, activeProfileId: profile.id });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/admin/settings', adminMiddleware, (req, res) => {
  res.json({
    allowRegistration:    getSetting('allowRegistration',    '1') !== '0',
    aiEnabled:            getSetting('aiEnabled',            '1') !== '0',
    maintenanceMode:      getSetting('maintenanceMode',      '0') === '1',
    defaultTrackerLimit:  parseInt(getSetting('defaultTrackerLimit',  '0')   || '0'),
    historyRetentionCap:  parseInt(getSetting('historyRetentionCap',  '500') || '500'),
    userIntervalOptions:  getUserAllowedIntervals(),
  });
});

app.patch('/api/admin/settings', adminMiddleware, (req, res) => {
  const allowed = ['allowRegistration', 'aiEnabled', 'maintenanceMode', 'defaultTrackerLimit', 'historyRetentionCap', 'userIntervalOptions'];
  const VALID_INTERVALS = new Set([60000, 300000, 900000, 1800000, 3600000, 14400000, 21600000, 43200000, 86400000, 259200000, 604800000]);
  for (const key of allowed) {
    if (!(key in req.body)) continue;
    const val = req.body[key];
    if (key === 'userIntervalOptions') {
      // Accept either a JSON string or a pre-parsed array from the client
      let list;
      try { list = typeof val === 'string' ? JSON.parse(val) : val; } catch { list = []; }
      const clean = (Array.isArray(list) ? list : []).map(Number).filter(v => VALID_INTERVALS.has(v));
      if (clean.length === 0)
        return res.status(400).json({ error: 'At least one interval option must be enabled.' });
      setSetting(key, JSON.stringify(clean));
    } else {
      setSetting(key, typeof val === 'boolean' ? (val ? '1' : '0') : String(val));
    }
  }
  res.json({ ok: true });
});

app.post('/api/admin/users', adminMiddleware, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (!email?.trim())
    return res.status(400).json({ error: 'Email address is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: 'Please enter a valid email address' });
  if (username.trim().length < 2)
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  const adminCreatePwError = passwordPolicyError(password, 'Password');
  if (adminCreatePwError)
    return res.status(400).json({ error: adminCreatePwError });
  const allowedRoles = ['user', 'admin'];
  const assignedRole = allowedRoles.includes(role) ? role : 'user';

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
  if (existing) return res.status(409).json({ error: 'That username is already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const initLimit = (() => {
    const g = parseInt(getSetting('defaultTrackerLimit', '0') || '0');
    return g > 0 ? g : null;
  })();
  const user = { id: uuidv4(), username: username.trim(), email: email.trim().toLowerCase(), passwordHash, role: assignedRole, createdAt: new Date().toISOString(), emailVerified: 0 };
  const adminDefaultProfileId = uuidv4();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, username, email, passwordHash, role, createdAt, trackerLimit, emailVerified, activeProfileId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.username, user.email, user.passwordHash, user.role, user.createdAt, initLimit, user.emailVerified, adminDefaultProfileId);
    db.prepare('INSERT INTO profiles (id, userId, name, isDefault, createdAt) VALUES (?, ?, ?, 1, ?)')
      .run(adminDefaultProfileId, user.id, 'Default', user.createdAt);
  })();
  const verificationEmailSent = await sendEmailVerificationEmail(user, req);
  res.status(201).json({ id: user.id, username: user.username, role: user.role, emailVerified: false, verificationEmailSent });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, email, emailVerified, role, createdAt, disabled, trackerLimit FROM users ORDER BY createdAt ASC').all();
  const trackerCounts = {};
  trackers.forEach(t => { trackerCounts[t.userId] = (trackerCounts[t.userId] || 0) + 1; });
  res.json(users.map(u => ({ ...u, emailVerified: u.emailVerified === 1, disabled: u.disabled === 1, trackerCount: trackerCounts[u.id] || 0, gravatarUrl: gravatarUrl(u.email, 40) })));
});

app.patch('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot modify your own account this way' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { disabled, trackerLimit, email, role, username, newPassword } = req.body;
  let emailChanged = false;

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

  if (username !== undefined) {
    const trimmed = String(username || '').trim();
    if (trimmed.length < 2)
      return res.status(400).json({ error: 'Username must be at least 2 characters' });
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(trimmed, targetId);
    if (conflict) return res.status(409).json({ error: 'That username is already taken' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(trimmed, targetId);
  }

  if (email !== undefined) {
    const trimmed = (email || '').trim();
    if (!trimmed)
      return res.status(400).json({ error: 'Email address is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      return res.status(400).json({ error: 'Please enter a valid email address' });
    const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(trimmed, targetId);
    if (conflict) return res.status(409).json({ error: 'An account with that email already exists' });
    db.prepare('UPDATE users SET email = ?, emailVerified = 0 WHERE id = ?').run(trimmed.toLowerCase(), targetId);
    emailChanged = true;
  }

  if (newPassword !== undefined && String(newPassword).trim() !== '') {
    const pwError = passwordPolicyError(newPassword, 'New password');
    if (pwError) return res.status(400).json({ error: pwError });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, targetId);
  }

  if (role !== undefined) {
    const allowedRoles = ['user', 'admin'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  }

  let verificationEmailSent = false;
  if (emailChanged && _isSesConfigured()) {
    const verifyUser = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(targetId);
    verificationEmailSent = await sendEmailVerificationEmail(verifyUser, req);
  }

  res.json({ success: true, verificationEmailSent });
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
  _saveOneTracker(tracker);
  res.json({ success: true });
});

app.delete('/api/admin/trackers/:id', adminMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  const targetUserId = tracker.userId;
  stopTrackerTimer(tracker.id);
  db.transaction(() => {
    db.prepare('DELETE FROM changes WHERE trackerId = ?').run(tracker.id);
    db.prepare('DELETE FROM trackers WHERE id = ?').run(tracker.id);
  })();
  trackers = trackers.filter(t => t.id !== tracker.id);
  const userTrackers = trackers
    .filter(t => t.userId === targetUserId)
    .map(({ lastBody, ...rest }) => rest);
  broadcastToUser({ type: 'update', trackers: userTrackers }, targetUserId);
  res.json({ success: true });
});

app.post('/api/admin/impersonate/:id', adminMiddleware, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot impersonate yourself' });
  const target = db.prepare('SELECT id, username, role, email, emailVerified, disabled, notificationsEnabled, hideAiFinder, hideAddTracker, changesMaxHeight, trackerLimit, disableAiSummary FROM users WHERE id = ?').get(targetId);
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
    hideAiFinder: target.hideAiFinder === 1,
    hideAddTracker: target.hideAddTracker === 1,
    changesMaxHeight: target.changesMaxHeight || 0,
    trackerLimit: target.trackerLimit ?? null,
    disableAiSummary: target.disableAiSummary === 1,
    emailVerified: target.emailVerified === 1,
    gravatarUrl: gravatarUrl(target.email, 64),
    impersonatedBy: { id: req.userId, username: req.username } });
});

app.post('/api/admin/stop-impersonate', (req, res) => {
  const restoreToken = req.cookies?.watchbot_restore;
  if (!restoreToken) return res.status(400).json({ error: 'No impersonation session to restore' });
  let payload;
  try {
    payload = jwt.verify(restoreToken, JWT_SECRET);
  } catch {
    res.clearCookie('watchbot_restore');
    res.clearCookie('watchbot_auth');
    return res.status(401).json({ error: 'Restore token invalid or expired' });
  }
  res.cookie('watchbot_auth', restoreToken, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  res.clearCookie('watchbot_restore');
  const user = db.prepare('SELECT username, role, email, emailVerified, notificationsEnabled, hideAiFinder, hideAddTracker, changesMaxHeight, trackerLimit, disableAiSummary FROM users WHERE id = ?').get(payload.userId);
  res.json({ id: payload.userId, username: user?.username || payload.username, role: user?.role || 'admin',
    notificationsEnabled: user?.notificationsEnabled !== 0,
    hideAiFinder: user?.hideAiFinder === 1,
    hideAddTracker: user?.hideAddTracker === 1,
    changesMaxHeight: user?.changesMaxHeight || 0,
    trackerLimit: user?.trackerLimit ?? null,
    disableAiSummary: user?.disableAiSummary === 1,
    emailVerified: user?.emailVerified === 1,
    gravatarUrl: gravatarUrl(user?.email, 64) });
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
app.post('/api/summarize', authMiddleware, async (req, res) => {
  const { oldText, newText, url } = req.body;
  const summary = await getChangeSummary(oldText, newText, url);
  res.json({ summary });
});

app.get('/api/trackers', authMiddleware, (req, res) => {
  res.json(getActiveProfileTrackers(req.userId));
});

app.post('/api/trackers', authMiddleware, async (req, res) => {
  const { url, label, interval, aiSummary, emailNotify } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (req.role !== 'admin' && interval && !getUserAllowedIntervals().includes(Number(interval)))
    return res.status(400).json({ error: 'That check interval is not available. Please choose from the allowed options.' });

  const userRow = db.prepare('SELECT trackerLimit FROM users WHERE id = ?').get(req.userId);
  // null or 0 = unlimited; positive integer = hard cap. Global default is only applied at user creation.
  const effectiveLimit = (userRow?.trackerLimit > 0) ? userRow.trackerLimit : null;
  if (effectiveLimit !== null) {
    const count = trackers.filter(t => t.userId === req.userId).length;
    if (count >= effectiveLimit)
      return res.status(403).json({ error: `WatchBot limit reached (${effectiveLimit})` });
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
    faviconUrl:   null,
    createdAt:    new Date().toISOString(),
    userId:       req.userId,
    profileId:    getUserActiveProfileId(req.userId),
  };

  trackers.unshift(tracker);
  saveTrackers(trackers);
  startTrackerTimer(tracker);
  enqueueCheck(tracker); // queue first check — respects concurrency limit

  const { lastBody, ...safe } = tracker;
  res.status(201).json(safe);

  // Fetch favicon in the background — don't block the response
  fetchAndStoreFavicon(tracker.url).then(cdnUrl => {
    if (cdnUrl && !tracker.faviconUrl) {
      tracker.faviconUrl = cdnUrl;
      _saveOneTracker(tracker);
    }
  }).catch(() => {});
});

app.patch('/api/trackers/reorder', authMiddleware, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  const activeProfileId = getUserActiveProfileId(req.userId);
  const profileTrackerIds = new Set(
    trackers.filter(t => t.userId === req.userId && t.profileId === activeProfileId).map(t => t.id)
  );
  if (ids.some(id => !profileTrackerIds.has(id)))
    return res.status(403).json({ error: 'Forbidden' });

  const posMap = {};
  ids.forEach((id, i) => { posMap[id] = i; });

  // Re-sort: profile trackers get new positions; other trackers keep their relative order
  // We need to interleave profile trackers (in new order) with non-profile trackers (unchanged)
  const profileTrackers    = trackers.filter(t => t.userId === req.userId && t.profileId === activeProfileId);
  const nonProfileTrackers = trackers.filter(t => !(t.userId === req.userId && t.profileId === activeProfileId));
  profileTrackers.sort((a, b) => (posMap[a.id] ?? 0) - (posMap[b.id] ?? 0));
  trackers = [...profileTrackers, ...nonProfileTrackers];

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

  if (req.body.interval !== undefined) {
    const interval = Number(req.body.interval);
    if (!Number.isFinite(interval) || interval <= 0)
      return res.status(400).json({ error: 'Invalid interval' });
    if (req.role !== 'admin' && !getUserAllowedIntervals().includes(interval)) {
      return res.status(400).json({ error: 'That check interval is not available. Please choose from the allowed options.' });
    }
    tracker.interval = interval;
  }

  if (req.body.label !== undefined) tracker.label = String(req.body.label || '').trim();
  if (req.body.active !== undefined) tracker.active = !!req.body.active;
  if (req.body.aiSummary !== undefined) tracker.aiSummary = req.body.aiSummary !== false;
  if (req.body.emailNotify !== undefined) tracker.emailNotify = !!req.body.emailNotify;

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

app.post('/api/changes/:id/flag', authMiddleware, (req, res) => {
  const change = db.prepare('SELECT trackerId, flagged FROM changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  const tracker = trackers.find(t => t.id === change.trackerId && t.userId === req.userId);
  if (!tracker) return res.status(403).json({ error: 'Forbidden' });
  const newFlagged = change.flagged ? 0 : 1;
  db.prepare('UPDATE changes SET flagged = ? WHERE id = ?').run(newFlagged, req.params.id);
  tracker.flaggedCount = Math.max((tracker.flaggedCount || 0) + (newFlagged === 1 ? 1 : -1), 0);
  _saveOneTracker(tracker);
  res.json({ flagged: newFlagged === 1 });
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
    'SELECT id, detectedAt, summary, aiDisabledReason, dismissed, flagged, soft, snippet FROM changes WHERE trackerId = ? ORDER BY detectedAt DESC LIMIT ? OFFSET ?'
  ).all(req.params.id, limit, offset);
  const items = rows.map(r => ({ ...r, snippet: r.snippet ? JSON.parse(r.snippet) : null }));
  res.json({ items, total, offset, limit });
});

app.delete('/api/trackers/:id/changes', authMiddleware, (req, res) => {
  const tracker = trackers.find(t => t.id === req.params.id && t.userId === req.userId);
  if (!tracker) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM changes WHERE trackerId = ? AND flagged = 0').run(req.params.id);
  const remainingFlagged = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ?').get(req.params.id).c;
  tracker.changeCount = remainingFlagged;
  if (remainingFlagged === 0) {
    tracker.changeSummary = null;
    tracker.changeSnippet = null;
  }
  // Only reset 'changed' status if no unread, unflagged changes remain
  const stillUnread = db.prepare('SELECT COUNT(*) as c FROM changes WHERE trackerId = ? AND dismissed = 0 AND flagged = 0').get(req.params.id).c;
  if (stillUnread === 0 && tracker.status === 'changed') tracker.status = 'ok';
  saveTrackers(trackers);
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const userCount   = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE disabled = 0').get().c;
  const activeCount = trackers.filter(t => t.active).length;
  const changedCount = trackers.filter(t => t.status === 'changed').length;

  const allowRegistration = getSetting('allowRegistration', '1') !== '0';
  const maintenanceMode   = getSetting('maintenanceMode',   '0') === '1';
  const aiEnabled         = getSetting('aiEnabled',         '1') !== '0';
  const defaultLimit      = parseInt(getSetting('defaultTrackerLimit', '0') || '0');
  const retentionCap      = Math.max(parseInt(getSetting('historyRetentionCap', '500') || '500'), 10);
  const userIntervals     = getUserAllowedIntervals();

  const aiApiConfigured = !!process.env.ANTHROPIC_API_KEY;
  const sesConfigured   = _isSesConfigured();
  const s3Configured    = !!(S3_MEDIA_BUCKET && CDN_BASE_URL);

  const yn = (v, yes = 'enabled', no = 'disabled') => v ? `${_c.green}${yes}${_c.r}` : `${_c.red}${no}${_c.r}`;
  const STARTUP_LABEL_WIDTH = 13; // keep colon alignment stable for Settings(raw)
  const startupLine = (label, value) => {
    console.log(`   ${_c.dim}${label.padEnd(STARTUP_LABEL_WIDTH)}:${_c.r} ${value}`);
  };

  console.log(`\n${_c.bold}${_c.green}🤖 Watchbot${_c.r}  listening on ${_c.cyan}http://localhost:${PORT}${_c.r}`);
  startupLine('Database', DB_PATH);
  startupLine('Trackers', `${trackers.length} total, ${activeCount} active, ${changedCount} changed`);
  startupLine('Users', `${userCount} total, ${activeUsers} active`);
  startupLine('Settings', `registration ${yn(allowRegistration, 'open', 'closed')}, maintenance ${yn(maintenanceMode, 'on', 'off')}, AI summaries ${yn(aiEnabled, 'on', 'off')}`);
  startupLine('Limits', `default tracker limit ${defaultLimit > 0 ? defaultLimit : 'none'}, history cap ${retentionCap}, user intervals ${userIntervals.length}`);
  startupLine('CORS', CORS_ALLOWLIST.length > 0 ? CORS_ALLOWLIST.join(', ') : 'same-origin only');
  startupLine('Integrations', `AI API ${yn(aiApiConfigured, 'configured', 'missing key')}, SES ${yn(sesConfigured, 'configured', 'not configured')}, S3 favicon cache ${yn(s3Configured, 'configured', 'not configured')}`);
  startupLine('Runtime', `NODE_ENV ${process.env.NODE_ENV || 'development'}, CHECK_CONCURRENCY ${CHECK_CONCURRENCY}`);
  if (aiEnabled && !aiApiConfigured) {
    startupLine('Note', `${_c.yellow}AI summaries are enabled in settings, but ANTHROPIC_API_KEY is missing. Checks will log AI skipped/fallback summaries.${_c.r}`);
  } else if (!aiEnabled && aiApiConfigured) {
    startupLine('Note', `${_c.yellow}ANTHROPIC_API_KEY is configured, but AI summaries are disabled by Admin setting.${_c.r}`);
  }
  startupLine('Legend', `${_c.dim}↻ check start | ⚡ changed (includes AI used/skipped + reason) | · no changes found | ~ soft/no-significant change | ✓ baseline/success | ✗ error | ✉ email | ⇄ SSE | ⏱ scheduler${_c.r}`);
  console.log('');

  trackers.forEach(t => { if (t.active) startTrackerTimer(t); });
});
