// Shared multi-file model for skills, agents and contexts. Each entity is composed
// of N files: exactly one entry file (is_entry=1, fixed name like SKILL.md /
// AGENT.md / CONTEXT.md) plus supporting files of any extension. The entry holds
// what used to live in the legacy single `content` column; supporting files are
// emitted after it when the entity is hoisted into a compiled workflow.
import db from '../db/client';
import { v4 as uuidv4 } from 'uuid';
import { EntityFile } from '../db/schema';

// Names may be any text resource (markdown, scripts, configs…). No slashes/spaces
// — prevents path traversal and keeps names safe to render. Must carry an extension.
export const FILENAME_RE = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/;

export interface IncomingFile {
  name?: string;
  description?: string;
  content?: string;
  is_entry?: boolean | number;
}

export interface NormalizedFile {
  name: string;
  description: string;
  content: string;
  is_entry: number;
}

export type NormalizeResult =
  | { ok: true; files: NormalizedFile[] }
  | { ok: false; error: string };

export interface FileConfig {
  table: string;      // child table, e.g. 'skill_files'
  fk: string;         // foreign-key column, e.g. 'skill_id'
  parent: string;     // parent table, e.g. 'skills' (legacy content column updated here)
  entryName: string;  // required entry file name, e.g. 'SKILL.md'
  requireEntryContent?: boolean; // default true — entry must be non-empty
}

// Validate + normalize an incoming files array. Accepts the legacy {content}
// payload (treated as a single entry file) for backward compatibility.
export function normalizeFiles(
  files: IncomingFile[] | undefined,
  legacyContent: string | undefined,
  cfg: FileConfig
): NormalizeResult {
  const requireEntry = cfg.requireEntryContent !== false;

  // Backward compat: no files array → fall back to legacy single-blob content.
  if (!Array.isArray(files) || files.length === 0) {
    const content = (legacyContent ?? '').trim();
    if (requireEntry && !content) {
      return { ok: false, error: 'At least one file (or `content`) is required' };
    }
    return { ok: true, files: [{ name: cfg.entryName, description: '', content, is_entry: 1 }] };
  }

  const seen = new Set<string>();
  let entryCount = 0;
  const out: NormalizedFile[] = [];

  for (const raw of files) {
    const name = String(raw.name ?? '').trim();
    const description = String(raw.description ?? '').trim();
    const content = String(raw.content ?? '');
    const is_entry = raw.is_entry ? 1 : 0;

    if (!name) return { ok: false, error: 'Each file must have a name' };
    if (!FILENAME_RE.test(name)) {
      return { ok: false, error: `Invalid file name "${name}". Allowed: letters, digits, '.', '_', '-', and a file extension (e.g. .md, .sh, .json)` };
    }
    if (seen.has(name.toLowerCase())) return { ok: false, error: `Duplicate file name: ${name}` };
    seen.add(name.toLowerCase());
    if (is_entry) entryCount++;
    if (is_entry && name !== cfg.entryName) {
      return { ok: false, error: `Entry file must be named ${cfg.entryName} (got "${name}")` };
    }
    // Entry content is optional when requireEntryContent is false; supporting files
    // must always carry content (an empty supporting file is meaningless).
    if (!content.trim() && !(is_entry && !requireEntry)) {
      return { ok: false, error: `File "${name}" content is empty` };
    }

    out.push({ name, description, content, is_entry });
  }

  if (entryCount !== 1) {
    return { ok: false, error: `Exactly one file must be marked as entry (got ${entryCount})` };
  }
  if (!seen.has(cfg.entryName.toLowerCase())) {
    return { ok: false, error: `${cfg.entryName} is required` };
  }
  return { ok: true, files: out };
}

// Replace all files for a parent row, then keep the legacy `content` column
// populated with the entry file's content for safe rollback.
export function writeEntityFiles(parentId: string, files: NormalizedFile[], cfg: FileConfig): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${cfg.table} WHERE ${cfg.fk} = ?`).run(parentId);
    const ins = db.prepare(
      `INSERT INTO ${cfg.table} (id, ${cfg.fk}, name, description, content, is_entry, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    files.forEach((f, idx) => {
      ins.run(uuidv4(), parentId, f.name, f.description, f.content, f.is_entry, idx);
    });
    const entry = files.find(f => f.is_entry);
    if (entry) db.prepare(`UPDATE ${cfg.parent} SET content = ? WHERE id = ?`).run(entry.content, parentId);
  });
  tx();
}

// Load a parent's files, entry first then supporting files by ordinal.
export function loadEntityFiles(parentId: string, cfg: FileConfig): EntityFile[] {
  return db.prepare(
    `SELECT id, name, description, content, is_entry, ordinal FROM ${cfg.table}
     WHERE ${cfg.fk} = ? ORDER BY is_entry DESC, ordinal ASC, name ASC`
  ).all(parentId) as EntityFile[];
}

// Map a file's extension to a fenced-code-block language hint. Markdown / plain
// text render inline as prose (returns null); everything else (scripts, configs,
// source) is emitted inside a code fence so the agent can read and reuse it.
const FILE_LANG: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  sql: 'sql', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  php: 'php', html: 'html', css: 'css', xml: 'xml', dockerfile: 'dockerfile',
};

// Returns a fence language for non-markdown files, or null when the file should
// render inline as markdown/plain prose.
export function fenceLangForFile(name: string): string | null {
  const ext = (name.toLowerCase().split('.').pop() || '');
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return null;
  return FILE_LANG[ext] ?? '';
}

// Render a list of entity files into prompt lines: entry content inline, then each
// supporting file labelled, with non-markdown files wrapped in a code fence.
export function renderFilesToLines(files: EntityFile[], lines: string[]): void {
  const entry = files.find(f => f.is_entry);
  const supporting = files.filter(f => !f.is_entry);
  if (entry && entry.content.trim()) {
    lines.push(entry.content.trim());
    lines.push('');
  }
  for (const f of supporting) {
    const subtitle = f.description ? ` — *${f.description}*` : '';
    lines.push(`**File: ${f.name}**${subtitle}`);
    lines.push('');
    if (f.content && f.content.trim()) {
      const lang = fenceLangForFile(f.name);
      if (lang === null) {
        lines.push(f.content.trim());
      } else {
        lines.push('```' + lang);
        lines.push(f.content.replace(/\s+$/, ''));
        lines.push('```');
      }
      lines.push('');
    }
  }
}

// Pre-built configs for the three entity types.
export const SKILL_FILES: FileConfig   = { table: 'skill_files',   fk: 'skill_id',   parent: 'skills',   entryName: 'SKILL.md',   requireEntryContent: true };
export const AGENT_FILES: FileConfig   = { table: 'agent_files',   fk: 'agent_id',   parent: 'agents',   entryName: 'AGENT.md',   requireEntryContent: false };
export const CONTEXT_FILES: FileConfig = { table: 'context_files', fk: 'context_id', parent: 'contexts', entryName: 'CONTEXT.md', requireEntryContent: true };
