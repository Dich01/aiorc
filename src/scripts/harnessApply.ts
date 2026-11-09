// npm run harness:apply -- <harness dir> [--owner email] [--dry-run]
//
// Validates the harness with the server's own validators, then loads it into
// the database idempotently and prints the content hash of every entity.
// The owner defaults to the only admin account (AIORC_HARNESS_OWNER overrides).
import db from '../db/client';
import { loadHarness, HarnessError } from '../harness/load';
import { applyHarness } from '../harness/apply';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dir = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--owner');
  if (!dir) { console.error('usage: npm run harness:apply -- <harness dir> [--owner email] [--dry-run]'); process.exit(2); }

  let harness;
  try { harness = loadHarness(dir); }
  catch (err) {
    if (err instanceof HarnessError) {
      console.error(`The harness at ${dir} is not valid:`);
      for (const p of err.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Harness "${harness.name}": ${harness.agents.size} agents, ${harness.skills.size} skills, ${harness.contexts.size} contexts, ${harness.projects.length} projects. Valid.`);
  if (process.argv.includes('--dry-run')) return;

  const ownerEmail = (arg('--owner') ?? process.env.AIORC_HARNESS_OWNER ?? '').trim().toLowerCase();
  let owner: { id: string; email: string } | undefined;
  if (ownerEmail) owner = db.prepare('SELECT id, email FROM users WHERE LOWER(email) = ?').get(ownerEmail) as typeof owner;
  else {
    const admins = db.prepare("SELECT id, email FROM users WHERE role = 'admin'").all() as { id: string; email: string }[];
    if (admins.length === 1) owner = admins[0];
    else { console.error(admins.length ? 'Several admins exist: pass --owner <email>.' : 'No admin exists yet: run npm run admin:create first.'); process.exit(1); }
  }
  if (!owner) { console.error(`No user with email ${ownerEmail}.`); process.exit(1); }

  const report = applyHarness(harness, owner.id);
  console.log(`Applied as ${owner.email}. Created: ${report.created.length}. Updated: ${report.updated.length}.`);
  for (const c of report.created) console.log(`  + ${c}`);
  for (const u of report.updated) console.log(`  ~ ${u}`);
  console.log('Content hashes (sha256):');
  for (const h of report.hashes) console.log(`  ${h.sha256}  ${h.kind.padEnd(7)} ${h.name}`);
  for (const k of report.newProjectKeys) {
    console.log(`\nProject key for ${k.project} (shown once, store it now):\n  ${k.api_key}`);
  }
}

main();
