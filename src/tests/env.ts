// Imported first by run.ts, before anything touches the database: every test
// run gets its own throwaway SQLite file and fixed secrets, so tests never read
// or write ./data or the real secret files.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiorc-test-'));
process.env.AIORC_DB_PATH = path.join(TEST_DIR, 'test.db');
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
process.env.AUDIT_SIGNING_KEY = process.env.AUDIT_SIGNING_KEY ?? 'test-audit-key';

process.on('exit', () => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});
