#!/usr/bin/env node
/**
 * seed-test-users.js
 * Creates 50 test user accounts in the Watchbot database.
 *
 * Usage:
 *   node scripts/seed-test-users.js
 *
 * Accounts created:
 *   usernames : testuser_01 … testuser_50
 *   emails    : testuser_01@example.com … testuser_50@example.com
 *   password  : Testpass1!   (same for all)
 *
 * Safe to re-run — existing usernames/emails are skipped.
 */

'use strict';

const path    = require('path');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/watchbot.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const PASSWORD   = 'Testpass1!';
const USER_COUNT = 50;

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10); // cost 10 — fast enough for a seed script

  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, email, passwordHash, createdAt, role)
    VALUES (?, ?, ?, ?, ?, 'user')
  `);

  let created = 0;
  let skipped = 0;

  const insertMany = db.transaction(() => {
    for (let i = 1; i <= USER_COUNT; i++) {
      const n        = String(i).padStart(2, '0');
      const username = `testuser_${n}`;
      const email    = `testuser_${n}@example.com`;
      const result   = insert.run(uuidv4(), username, email, hash, new Date().toISOString());
      if (result.changes > 0) created++;
      else skipped++;
    }
  });

  insertMany();

  console.log(`\n✓ Seed complete`);
  console.log(`  Created : ${created}`);
  console.log(`  Skipped : ${skipped} (already existed)`);
  console.log(`  Password: ${PASSWORD}\n`);

  db.close();
}

main().catch(err => {
  console.error('✗ Seed failed:', err.message);
  process.exit(1);
});
