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

test('a version 6 database is migrated in place to 7 and keeps its rows', () => {
  const file = path.join(TEST_DIR, 'v6.db');
  const v7 = openDatabase(file);
  v7.prepare("INSERT INTO users (id, email, password_hash, name, nickname, bio, role, created_at) VALUES ('u1', 'u1@t', 'x', 'u1', 'u1', '', 'user', 1)").run();
  v7.prepare("INSERT INTO projects (id, user_id, name, api_key_hash, created_at) VALUES ('p1', 'u1', 'kept', 'h1', 1)").run();
  v7.exec('ALTER TABLE projects DROP COLUMN execution_mode');
  v7.prepare('UPDATE schema_version SET version = 6').run();
  v7.close();

  const migrated = openDatabase(file);
  const row = migrated.prepare("SELECT name, execution_mode FROM projects WHERE id = 'p1'").get() as { name: string; execution_mode: string };
  assert.deepStrictEqual(row, { name: 'kept', execution_mode: 'verified' });
  assert.strictEqual((migrated.prepare('SELECT version FROM schema_version').get() as { version: number }).version, SCHEMA_VERSION);
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_reports'").get(), 'new tables are created');
  migrated.close();
});

test('a version 5 database is still refused', () => {
  const file = path.join(TEST_DIR, 'v5.db');
  const db5 = new Database(file);
  db5.exec('CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (5); CREATE TABLE projects (id TEXT);');
  db5.close();
  assert.throws(() => openDatabase(file), /schema version 5/);
});
