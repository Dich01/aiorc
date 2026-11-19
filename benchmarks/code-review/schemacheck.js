// Validate every self-declared finding against the harness finding schema
// (what the server enforces on verified runs).
const fs = require('fs'), path = require('path');
const Ajv = require(path.join(process.cwd(), 'node_modules/ajv')).default;
if (!process.env.BENCH_SCHEMA) { console.error('set BENCH_SCHEMA to the harness finding schema (finding.schema.json)'); process.exit(2); }
const schema = JSON.parse(fs.readFileSync(process.env.BENCH_SCHEMA, 'utf8'));
const v = new Ajv({ allErrors: true, strict: false }).compile(schema);
const dir = process.argv[2];
let total = 0, bad = 0; const reasons = {};
for (const f of fs.readdirSync(dir)) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).payload;
  const findings = p.self_declared_report ? (p.self_declared_report.findings || []) : (p.steps.filter(s => s.step === Math.max(...p.steps.map(x => x.step))).flatMap(s => s.output.findings || []));
  for (const x of findings) { total++; if (!v(x)) { bad++; for (const e of v.errors) { const k = `${e.instancePath || '/'} ${e.message}`; reasons[k] = (reasons[k] || 0) + 1; } } }
}
console.log(JSON.stringify({ findings: total, invalid: bad, reasons }));
