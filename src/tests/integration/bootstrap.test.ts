import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { TEST_DIR } from '../env';
import { openDatabase } from '../../db/client';
import { section, test } from '../harness';
import db from '../../db/client';
import { SCHEMA_VERSION } from '../../db/schema';
import { api, createUser, createProject, rpc } from './helpers';

section('bootstrap (integration)');

test('an empty database starts with no users at all (no seed)', () => {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  assert.strictEqual(n, 0);
});

test('the database records the schema version it was created with', () => {
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
  assert.strictEqual(row.version, SCHEMA_VERSION);
});

test('the app answers /health without opening its own port', async () => {
  const r = await api('/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
});

test('a project key reaches the MCP endpoint', async () => {
  const u = await createUser();
  const p = await createProject(u.token);
  const r = await rpc('initialize', {}, { 'x-project-key': p.api_key });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.result.serverInfo.name, 'AIOrc');
});

section('schema version guard');

test('a database at another schema version is refused unless AIORC_DB_RESET=1', () => {
  const file = path.join(TEST_DIR, 'old.db');
  const old = new Database(file);
  old.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('legacy');");
  old.close();

  assert.throws(() => openDatabase(file), /schema version 0/);
  assert.ok(fs.existsSync(file), 'the refused database must be left untouched');

  process.env.AIORC_DB_RESET = '1';
  try {
    const fresh = openDatabase(file);
    const users = (fresh.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    assert.strictEqual(users, 0);
    fresh.close();
  } finally {
    delete process.env.AIORC_DB_RESET;
  }
  const backups = fs.readdirSync(TEST_DIR).filter(f => f.startsWith('old.db.') && f.endsWith('.bak'));
  assert.strictEqual(backups.length, 1, 'the old database is renamed, not deleted');
});
