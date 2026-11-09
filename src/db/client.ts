import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from './schema';

// Database location: AIORC_DB_PATH (tests point it at a temp file) or
// ./data/aiorc.db by default.
export const DB_PATH = process.env.AIORC_DB_PATH
  ? path.resolve(process.env.AIORC_DB_PATH)
  : path.join(process.cwd(), 'data', 'aiorc.db');

function readVersion(conn: DatabaseType): number | null {
  const hasTables = conn.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).get() as { n: number };
  if (hasTables.n === 0) return null; // brand-new file
  const hasVersion = conn.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
  ).get();
  if (!hasVersion) return 0; // pre-v2 database
  const row = conn.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  return row?.version ?? 0;
}

// Move a database at the wrong version out of the way (with its WAL/SHM files)
// so a fresh one can be created in its place. Nothing is deleted.
function moveAside(file: string): string {
  const backup = `${file}.${Date.now()}.bak`;
  fs.renameSync(file, backup);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, backup + suffix);
  }
  return backup;
}

// Open (and if needed create) the database at `file`. Exported for tests.
export function openDatabase(file: string): DatabaseType {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let conn = new Database(file);
  const version = readVersion(conn);

  if (version !== null && version !== SCHEMA_VERSION) {
    if (process.env.AIORC_DB_RESET !== '1') {
      conn.close();
      throw new Error(
        `[AIOrc] The database at ${file} is at schema version ${version}, but this build needs version ${SCHEMA_VERSION}. ` +
        'There is no in-place migration. Start once with AIORC_DB_RESET=1 to move the old file aside (renamed to *.bak) and create an empty database.'
      );
    }
    conn.close();
    const backup = moveAside(file);
    console.warn(`[AIOrc] AIORC_DB_RESET=1: moved the version ${version} database to ${backup}`);
    conn = new Database(file);
  }

  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(CREATE_TABLES_SQL);
  const row = conn.prepare('SELECT version FROM schema_version LIMIT 1').get();
  if (!row) conn.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  return conn;
}

const db: DatabaseType = openDatabase(DB_PATH);

export default db;
