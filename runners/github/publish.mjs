#!/usr/bin/env node
// Deterministic publisher for AIOrc reviews on GitHub. No model, no
// dependencies, no checkout of the pull request's code.
//
// It verifies the signed export (Ed25519 signature, hash chain, outputs
// against the chain), checks that the export reviewed the pull request's
// current head commit, and only then publishes:
//   - one review comment on the PR, updated in place on every run,
//   - inline comments for the findings (one review per head commit, event
//     COMMENT: it never approves and never requests changes),
//   - a check run "aiorc/review" with conclusion "neutral" (advisory).
//
// usage: node publish.mjs --export <file> --repo <owner/name> --pr <n> --head-sha <sha>
//                         (--public-key <pem file> | --keys-url <url>) [--dry-run]
// env:   GITHUB_TOKEN (not needed with --dry-run), GITHUB_API_URL (default https://api.github.com)
// exit:  0 published (or planned), 1 the export failed verification, 2 usage error
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKER = '<!-- aiorc-review -->';
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

function args() {
  const a = process.argv.slice(2);
  const get = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  return {
    exportFile: get('--export'), repo: get('--repo'), pr: Number(get('--pr')), headSha: get('--head-sha'),
    publicKey: get('--public-key'), keysUrl: get('--keys-url'), dryRun: a.includes('--dry-run'),
  };
}

function usage(msg) { console.error(`publish: ${msg}`); process.exit(2); }

// ── Verification (mirrors src/lib/auditExport.ts in the AIOrc server) ───────

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
  if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
const kidOf = key => 'ed25519-' + sha256(key.export({ type: 'spki', format: 'der' }).toString('base64')).slice(0, 16);

export function verifyExport(doc, key, headSha) {
  const errors = [];
  const p = doc?.payload;
  if (!p || !doc.signature) return ['not an AIOrc audit export'];
  if (p.format !== 'aiorc.audit.v1') errors.push(`unknown format ${p.format}`);
  if (doc.signature.alg !== 'Ed25519') errors.push('signature is not Ed25519');
  if (doc.signature.kid !== kidOf(key)) errors.push(`signed with key ${doc.signature.kid}, expected ${kidOf(key)}`);
  let sigOk = false;
  try { sigOk = verify(null, Buffer.from(canonicalJson(p), 'utf8'), key, Buffer.from(doc.signature.value, 'base64')); } catch { sigOk = false; }
  if (!sigOk) errors.push('signature does not match the payload');

  let prev = '0'.repeat(64);
  (p.events ?? []).forEach((e, i) => {
    if (e.seq !== i + 1 || e.prev_hash !== prev || e.run_id !== p.run.id) errors.push(`event ${i + 1} is out of chain`);
    if (sha256(prev + canonicalJson({ run_id: e.run_id, seq: e.seq, type: e.type, payload: e.payload, at: e.at })) !== e.hash) errors.push(`event ${e.seq} was altered`);
    prev = e.hash;
  });
  if (!p.events?.length || p.chain_head !== prev) errors.push('chain head does not match the events');

  const recorded = new Map();
  for (const e of p.events ?? []) if (e.type === 'step.completed') for (const o of e.payload.outputs ?? []) recorded.set(`${e.payload.step}:${o.node}`, o.sha256);
  for (const s of p.steps ?? []) {
    if (sha256(canonicalJson(s.output)) !== s.sha256 || recorded.get(`${s.step}:${s.node}`) !== s.sha256) errors.push(`output of step ${s.step} (${s.node}) does not match the chain`);
  }
  if ((p.steps ?? []).length !== recorded.size) errors.push('step outputs differ from the chain');

  if (p.review?.head_sha !== headSha) errors.push(`the export reviewed ${p.review?.head_sha ?? 'no commit'}, not the pull request head ${headSha}`);
  return errors;
}

// The findings of the last completed step (the report), shape-checked.
export function finalFindings(p) {
  const last = Math.max(0, ...(p.steps ?? []).map(s => s.step));
  const raw = (p.steps ?? []).filter(s => s.step === last).flatMap(s => (Array.isArray(s.output?.findings) ? s.output.findings : []));
  return raw.filter(f => f && typeof f.file === 'string' && typeof f.title === 'string' && SEVERITIES.includes(f.severity) && Number.isInteger(f.line_start))
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
}

// ── What to publish ─────────────────────────────────────────────────────────

const md = s => String(s ?? '').replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;')).replace(/@/g, '@​');

export function plan(doc, headSha) {
  const p = doc.payload;
  const findings = finalFindings(p);
  const completed = p.run.status === 'completed';
  const counts = SEVERITIES.slice().reverse().map(s => [s, findings.filter(f => f.severity === s).length]).filter(([, n]) => n);
  const title = !completed ? `AIOrc review did not complete (${p.run.status})`
    : findings.length ? `AIOrc review: ${findings.length} finding(s), outcome ${p.run.outcome}` : `AIOrc review: no findings, outcome ${p.run.outcome}`;
  const lines = [
    MARKER,
    `### ${md(title)}`,
    '',
    `Reviewed \`${headSha.slice(0, 12)}\` against \`${String(p.review.base_sha).slice(0, 12)}\`. Run \`${p.run.id}\`, ${p.events.length} signed events (key \`${doc.signature.kid}\`). This review is advisory.`,
    '',
  ];
  if (counts.length) lines.push(counts.map(([s, n]) => `${n} ${s}`).join(' · '), '');
  for (const f of findings.slice(0, 50)) lines.push(`- **${f.severity}** \`${md(f.file)}:${f.line_start}\` ${md(f.title)}`);
  if (findings.length > 50) lines.push(`- ... and ${findings.length - 50} more`);
  const body = lines.join('\n');

  const comments = findings.slice(0, 30).map(f => {
    const c = { path: f.file, line: Number.isInteger(f.line_end) && f.line_end >= f.line_start ? f.line_end : f.line_start, side: 'RIGHT', body: `**${f.severity} · ${md(f.category)}**: ${md(f.title)}\n\n${md(f.evidence)}\n\n${md(f.suggestion)}` };
    if (c.line !== f.line_start) { c.start_line = f.line_start; c.start_side = 'RIGHT'; }
    return c;
  });
  return {
    comment: body,
    review: comments.length ? { commit_id: headSha, event: 'COMMENT', body: `${MARKER}\n<!-- head:${headSha} -->\nAIOrc findings for \`${headSha.slice(0, 12)}\`.`, comments } : null,
    check: { name: 'aiorc/review', head_sha: headSha, status: 'completed', conclusion: 'neutral', output: { title, summary: body.replace(MARKER, '').trim() } },
  };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function gh(method, path, body) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

async function listAll(path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const items = await gh('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

async function publish({ repo, pr, headSha }, p) {
  const comments = await listAll(`/repos/${repo}/issues/${pr}/comments`);
  const mine = comments.find(c => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (mine) await gh('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body: p.comment });
  else await gh('POST', `/repos/${repo}/issues/${pr}/comments`, { body: p.comment });

  if (p.review) {
    const reviews = await listAll(`/repos/${repo}/pulls/${pr}/reviews`);
    const already = reviews.some(r => typeof r.body === 'string' && r.body.includes(`<!-- head:${headSha} -->`));
    if (!already) {
      try { await gh('POST', `/repos/${repo}/pulls/${pr}/reviews`, p.review); }
      catch (err) {
        // A finding on a line outside the diff makes GitHub reject the whole
        // review; the summary comment above still lists every finding.
        if (err.status !== 422) throw err;
        console.error(`publish: inline comments rejected by GitHub (${err.message}); the summary comment has the findings.`);
      }
    }
  }
  await gh('POST', `/repos/${repo}/check-runs`, p.check);
}

async function main() {
  const a = args();
  if (!a.exportFile || !a.repo || !Number.isInteger(a.pr) || !/^[0-9a-f]{40}$/.test(a.headSha ?? '')) usage('--export, --repo, --pr and --head-sha are required');
  if (!a.publicKey && !a.keysUrl) usage('pass --public-key <pem> (preferred: pinned) or --keys-url <url>');

  let pem = a.publicKey ? readFileSync(a.publicKey, 'utf8') : null;
  if (!pem) {
    const r = await fetch(a.keysUrl);
    if (!r.ok) usage(`cannot fetch ${a.keysUrl}: ${r.status}`);
    pem = (await r.json()).keys?.[0]?.public_key_pem;
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') usage('the public key is not Ed25519');

  const doc = JSON.parse(readFileSync(a.exportFile, 'utf8'));
  const errors = verifyExport(doc, key, a.headSha);
  if (errors.length) {
    console.error('publish: the export failed verification; nothing was published:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const p = plan(doc, a.headSha);
  if (a.dryRun) { console.log(JSON.stringify(p, null, 2)); return; }
  if (!process.env.GITHUB_TOKEN) usage('GITHUB_TOKEN is required');
  await publish(a, p);
  console.log(`publish: ${p.check.output.title}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(`publish: ${err.message}`); process.exit(1); });
}
