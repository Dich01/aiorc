// Offline verification of a signed AIOrc audit export. No server, no database.
//
//   npm run audit:verify -- export.json --key public.pem
//   AIORC_AUDIT_PUBLIC_KEY="$(cat public.pem)" npm run audit:verify -- export.json
//
// The public key comes from GET /audit/keys on the server that signed it.
// Exit code 0 = valid, 1 = invalid, 2 = usage error.
import fs from 'fs';
import { KeyObject } from 'crypto';
import { publicKeyFromPem, keyId } from '../lib/auditKeys';
import { verifyExport } from '../lib/auditExport';

function usage(msg: string): never {
  console.error(msg);
  console.error('usage: npm run audit:verify -- <export.json> [--key <public.pem>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--key');
if (!file) usage('missing export file');
const keyArg = args.includes('--key') ? args[args.indexOf('--key') + 1] : undefined;

let pem = process.env.AIORC_AUDIT_PUBLIC_KEY ?? '';
if (keyArg) pem = fs.readFileSync(keyArg, 'utf8');
if (!pem) usage('no public key: pass --key <file> or set AIORC_AUDIT_PUBLIC_KEY (get it from GET /audit/keys)');

let doc: unknown;
try { doc = JSON.parse(fs.readFileSync(file!, 'utf8')); } catch (err) { usage(`cannot read ${file}: ${(err as Error).message}`); }

let pub: KeyObject;
try { pub = publicKeyFromPem(pem); } catch (err) { usage(`invalid public key: ${(err as Error).message}`); }
const keys = new Map([[keyId(pub!), pub!]]);
const result = verifyExport(doc, keys);

if (result.ok) {
  const p = (doc as { payload: { run: { id: string; status: string; outcome: string | null }; events: unknown[] } }).payload;
  const how = result.mode === 'compiled' ? '  (self-declared report, not server-verified)' : '';
  console.log(`VALID${how}  run ${p.run.id}  status=${p.run.status}  outcome=${p.run.outcome ?? '-'}  events=${p.events.length}  kid=${result.kid}`);
  process.exit(0);
}
console.log('INVALID');
for (const e of result.errors) console.log(`  - ${e}`);
process.exit(1);
