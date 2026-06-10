import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { CREATE_TABLES_SQL } from './schema';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'aiorc.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(CREATE_TABLES_SQL);

// Idempotent migrations for columns added after initial release
const safeAlter = (sql: string) => { try { db.exec(sql); } catch {} };
safeAlter("ALTER TABLE runs ADD COLUMN execution_report TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE agents ADD COLUMN expected_output_format TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE projects ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
safeAlter("ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
// Backfill nicknames for existing users from the email local-part (idempotent: only updates rows still empty).
safeAlter("UPDATE users SET nickname = SUBSTR(email, 1, INSTR(email,'@')-1) WHERE nickname = ''");
safeAlter("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname) WHERE nickname != ''");
safeAlter("ALTER TABLE projects ADD COLUMN forked_from TEXT");
safeAlter("CREATE INDEX IF NOT EXISTS idx_projects_forked_from ON projects(forked_from)");
safeAlter("ALTER TABLE agents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
safeAlter("ALTER TABLE agents ADD COLUMN forked_from TEXT");
safeAlter("CREATE INDEX IF NOT EXISTS idx_agents_forked_from ON agents(forked_from)");
safeAlter("ALTER TABLE skills ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
safeAlter("ALTER TABLE skills ADD COLUMN forked_from TEXT");
safeAlter("CREATE INDEX IF NOT EXISTS idx_skills_forked_from ON skills(forked_from)");
safeAlter("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE users ADD COLUMN last_login INTEGER");
safeAlter("ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN flow_json TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN caller_email TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN engine_state TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN eval_case_id TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN eval_verdict TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE runs ADD COLUMN eval_reasons TEXT NOT NULL DEFAULT ''");

// Backfill agent_files / context_files from the legacy single `content` column,
// mirroring the skill_files backfill above. Each entity gets a single entry file
// (AGENT.md / CONTEXT.md) holding its existing content.
for (const cfg of [
  { table: 'agent_files',   fk: 'agent_id',   parent: 'agents',   entry: 'AGENT.md' },
  { table: 'context_files', fk: 'context_id', parent: 'contexts', entry: 'CONTEXT.md' },
]) {
  try {
    const orphans = db.prepare(
      `SELECT p.id, p.content FROM ${cfg.parent} p
       WHERE NOT EXISTS (SELECT 1 FROM ${cfg.table} f WHERE f.${cfg.fk} = p.id)`
    ).all() as { id: string; content: string }[];
    if (orphans.length > 0) {
      const ins = db.prepare(
        `INSERT INTO ${cfg.table} (id, ${cfg.fk}, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, 1, 0)`
      );
      const tx = db.transaction(() => {
        for (const o of orphans) ins.run(randomUUID(), o.id, cfg.entry, '', o.content ?? '');
      });
      tx();
    }
  } catch (e) {
    console.warn(`[${cfg.table} backfill] failed:`, e);
  }
}

// Backfill skill_files: any skill without file rows gets a single SKILL.md
// row populated from its legacy `skills.content`. Runs once per skill; once a
// skill has files, this is a no-op for it.
try {
  const orphanSkills = db.prepare(
    `SELECT s.id, s.content FROM skills s
     WHERE NOT EXISTS (SELECT 1 FROM skill_files sf WHERE sf.skill_id = s.id)`
  ).all() as { id: string; content: string }[];
  if (orphanSkills.length > 0) {
    const ins = db.prepare(
      'INSERT INTO skill_files (id, skill_id, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, 1, 0)'
    );
    const tx = db.transaction(() => {
      for (const s of orphanSkills) {
        ins.run(randomUUID(), s.id, 'SKILL.md', '', s.content ?? '');
      }
    });
    tx();
  }
} catch (e) {
  console.warn('[skill_files backfill] failed:', e);
}

export default db;
