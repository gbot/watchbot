#!/usr/bin/env node
/**
 * seed-test-trackers.js
 * Creates ~50 test trackers using well-known public URLs, assigned to a
 * specific user account. Intervals are randomised; AI summary is OFF.
 *
 * Usage:
 *   node scripts/seed-test-trackers.js [--user <username>] [--count <n>]
 *
 * Options:
 *   --user <username>   Assign trackers to this user (default: admin)
 *   --count <n>         Number of trackers to create, max 65 (default: 50)
 *
 * Safe to re-run — duplicate URLs for the same user are skipped.
 *
 * NOTE: The server caches trackers in memory on startup.
 *       Restart the server after running this script to activate the new
 *       trackers and start their polling timers.
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database  = require('better-sqlite3');

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const userArg  = args[args.indexOf('--user')  + 1] || 'admin';
const countArg = parseInt(args[args.indexOf('--count') + 1]) || 50;

// ─── POPULAR URLs ─────────────────────────────────────────────────────────────
// 65 well-known public pages across diverse categories, all reliably reachable.
const ALL_URLS = [
  // Search
  { url: 'https://www.google.com',           label: 'Google' },
  { url: 'https://www.bing.com',             label: 'Bing' },
  { url: 'https://duckduckgo.com',           label: 'DuckDuckGo' },
  { url: 'https://search.yahoo.com',         label: 'Yahoo Search' },

  // Social / Community
  { url: 'https://www.reddit.com',           label: 'Reddit' },
  { url: 'https://news.ycombinator.com',     label: 'Hacker News' },
  { url: 'https://www.linkedin.com',         label: 'LinkedIn' },
  { url: 'https://www.producthunt.com',      label: 'Product Hunt' },
  { url: 'https://dev.to',                   label: 'DEV Community' },
  { url: 'https://medium.com',               label: 'Medium' },
  { url: 'https://lobste.rs',                label: 'Lobsters' },
  { url: 'https://slashdot.org',             label: 'Slashdot' },

  // News & Media
  { url: 'https://www.bbc.com/news',         label: 'BBC News' },
  { url: 'https://www.bbc.com/sport',        label: 'BBC Sport' },
  { url: 'https://www.theguardian.com',      label: 'The Guardian' },
  { url: 'https://www.reuters.com',          label: 'Reuters' },
  { url: 'https://apnews.com',               label: 'AP News' },
  { url: 'https://techcrunch.com',           label: 'TechCrunch' },
  { url: 'https://www.theverge.com',         label: 'The Verge' },
  { url: 'https://arstechnica.com',          label: 'Ars Technica' },
  { url: 'https://www.wired.com',            label: 'Wired' },
  { url: 'https://www.engadget.com',         label: 'Engadget' },
  { url: 'https://9to5mac.com',              label: '9to5Mac' },
  { url: 'https://www.macrumors.com',        label: 'MacRumors' },

  // Tech / Dev
  { url: 'https://github.com',               label: 'GitHub' },
  { url: 'https://www.npmjs.com',            label: 'npm' },
  { url: 'https://stackoverflow.com',        label: 'Stack Overflow' },
  { url: 'https://developer.mozilla.org',    label: 'MDN Web Docs' },
  { url: 'https://caniuse.com',              label: 'Can I Use' },
  { url: 'https://bundlephobia.com',         label: 'Bundlephobia' },
  { url: 'https://www.cloudflare.com',       label: 'Cloudflare' },
  { url: 'https://vercel.com',               label: 'Vercel' },
  { url: 'https://www.heroku.com',           label: 'Heroku' },
  { url: 'https://fly.io',                   label: 'Fly.io' },

  // Status pages
  { url: 'https://www.githubstatus.com',     label: 'GitHub Status' },
  { url: 'https://status.npmjs.org',         label: 'npm Status' },
  { url: 'https://status.openai.com',        label: 'OpenAI Status' },
  { url: 'https://status.anthropic.com',     label: 'Anthropic Status' },
  { url: 'https://www.cloudflarestatus.com', label: 'Cloudflare Status' },
  { url: 'https://status.vercel.com',        label: 'Vercel Status' },

  // Reference / Knowledge
  { url: 'https://en.wikipedia.org',         label: 'Wikipedia' },
  { url: 'https://www.wolframalpha.com',     label: 'Wolfram Alpha' },
  { url: 'https://www.merriam-webster.com',  label: 'Merriam-Webster' },

  // Finance
  { url: 'https://finance.yahoo.com',        label: 'Yahoo Finance' },
  { url: 'https://www.investing.com',        label: 'Investing.com' },
  { url: 'https://coinmarketcap.com',        label: 'CoinMarketCap' },
  { url: 'https://www.coindesk.com',         label: 'CoinDesk' },

  // Shopping / E-commerce
  { url: 'https://www.amazon.com',           label: 'Amazon' },
  { url: 'https://www.ebay.com',             label: 'eBay' },
  { url: 'https://www.etsy.com',             label: 'Etsy' },

  // Entertainment / Media
  { url: 'https://www.imdb.com',             label: 'IMDb' },
  { url: 'https://www.rottentomatoes.com',   label: 'Rotten Tomatoes' },
  { url: 'https://www.metacritic.com',       label: 'Metacritic' },

  // Weather / Science
  { url: 'https://weather.com',              label: 'Weather.com' },
  { url: 'https://www.accuweather.com',      label: 'AccuWeather' },
  { url: 'https://www.nasa.gov',             label: 'NASA' },

  // Productivity / Tools
  { url: 'https://www.notion.so',            label: 'Notion' },
  { url: 'https://trello.com',               label: 'Trello' },
  { url: 'https://www.figma.com',            label: 'Figma' },
  { url: 'https://linear.app',               label: 'Linear' },

  // Travel
  { url: 'https://www.booking.com',          label: 'Booking.com' },
  { url: 'https://www.airbnb.com',           label: 'Airbnb' },
  { url: 'https://www.tripadvisor.com',      label: 'TripAdvisor' },

  // Sports
  { url: 'https://www.espn.com',             label: 'ESPN' },
  { url: 'https://www.nba.com',              label: 'NBA' },
];

// Check interval options (ms)
const INTERVALS = [
  10_000,    // 10 s
  30_000,    // 30 s
  60_000,    // 1 min
  300_000,   // 5 min
  600_000,   // 10 min
  1_800_000, // 30 min
  3_600_000, // 1 hr
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function main() {
  const DB_PATH = path.join(__dirname, '../data/app.db');
  // Ensure the data directory exists before opening the database
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Resolve the target user
  const user = db.prepare('SELECT id, username, activeProfileId FROM users WHERE LOWER(username) = LOWER(?)').get(userArg);
  if (!user) {
    console.error(`✗ User "${userArg}" not found. Create the user first or pass --user <username>.`);
    db.close();
    process.exit(1);
  }

  // Resolve the profile to assign trackers to (use activeProfileId, fall back to default profile)
  let profileId = user.activeProfileId;
  if (!profileId) {
    const defaultProfile = db.prepare('SELECT id FROM profiles WHERE userId = ? AND isDefault = 1').get(user.id);
    profileId = defaultProfile?.id || null;
  }

  if (!profileId) {
    console.error(`✗ No profile found for user "${user.username}". Run the server once to auto-create one, or run seed-test-users.js first.`);
    db.close();
    process.exit(1);
  }

  // Get current max position for this user's trackers (to append without collision)
  const maxPosRow = db.prepare('SELECT MAX(position) AS mp FROM trackers WHERE userId = ?').get(user.id);
  let nextPos     = (maxPosRow?.mp ?? -1) + 1;

  // Get URLs already tracked by this user so we can skip duplicates
  const existingUrls = new Set(
    db.prepare('SELECT url FROM trackers WHERE userId = ?').all(user.id).map(r => r.url)
  );

  const candidates = shuffle(ALL_URLS).slice(0, Math.min(countArg, ALL_URLS.length));

  const insert = db.prepare(`
    INSERT INTO trackers
      (id, userId, label, url, interval, active, status,
       lastCheck, lastHash, lastBody, httpStatus, changeCount,
       changeSummary, changeSnippet, error, aiSummary, createdAt, position,
       emailNotify, faviconUrl, profileId)
    VALUES
      (?, ?, ?, ?, ?, 1, 'pending',
       NULL, NULL, NULL, NULL, 0,
       NULL, NULL, NULL, 0, ?, ?,
       0, NULL, ?)
  `);

  let created = 0;
  let skipped = 0;

  const insertMany = db.transaction(() => {
    for (const { url, label } of candidates) {
      if (existingUrls.has(url)) {
        skipped++;
        continue;
      }
      insert.run(
        uuidv4(),
        user.id,
        label,
        url,
        pick(INTERVALS),
        new Date().toISOString(),
        nextPos++,
        profileId
      );
      created++;
    }
  });

  insertMany();

  console.log(`\n✓ Trackers seeded for user "${user.username}"`);
  console.log(`  Profile : ${profileId}`);
  console.log(`  Created : ${created}`);
  console.log(`  Skipped : ${skipped} (URL already tracked by this user)`);
  console.log(`  AI summary: OFF`);
  console.log(`\n  ⚠  Restart the server to activate the new trackers.\n`);

  db.close();
}

main();
