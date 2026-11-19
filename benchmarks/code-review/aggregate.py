#!/usr/bin/env python3
"""Aggregate graded benchmark repetitions into one dataset.

usage: aggregate.py <out.json> <suite>:<mode>:<grade.json> [...]
       suite = base | complex, mode = server | model
Each grade.json is grade.ts output for one repetition. Also validates every
final finding against the harness finding schema (what the server enforces in
server-orchestrated mode) using the exports next to grade.json.
"""
import json, os, statistics, sys

out_file, specs = sys.argv[1], sys.argv[2:]
schema_file = os.environ.get('BENCH_SCHEMA')
if not schema_file: sys.exit('set BENCH_SCHEMA to the harness finding schema (finding.schema.json)')
schema = json.load(open(schema_file))
REQ, ENUMS = schema['required'], {k: v['enum'] for k, v in schema['properties'].items() if 'enum' in v}

def finding_ok(f):
    if not isinstance(f, dict): return False
    if any(k not in f for k in REQ): return False
    if any(k not in schema['properties'] for k in f): return False
    return all(f.get(k) in e for k, e in ENUMS.items())

def final_findings(payload):
    if payload.get('self_declared_report') is not None:
        return payload['self_declared_report'].get('findings') or []
    steps = payload.get('steps') or []
    last = max([s['step'] for s in steps] or [0])
    return [x for s in steps if s['step'] == last for x in (s['output'].get('findings') or [])]

runs, cases = [], {}
for spec in specs:
    suite, mode, grade_file = spec.split(':', 2)
    g = json.load(open(grade_file))
    rep = grade_file
    exports = os.path.join(os.path.dirname(grade_file), 'exports')
    for r in g['rows']:
        e = os.path.join(exports, r['id'] + '.json')
        valid = invalid = 0
        if os.path.exists(e):
            for f in final_findings(json.load(open(e))['payload']):
                if finding_ok(f): valid += 1
                else: invalid += 1
        runs.append({**{k: r.get(k) for k in ('id', 'kind', 'verdict', 'status', 'outcome', 'detected', 'findings', 'serious', 'seconds', 'cost', 'turns', 'in_tokens', 'out_tokens', 'verified_steps')},
                     'suite': suite, 'mode': mode, 'rep': rep, 'schema_invalid': invalid})

def summarize(rs):
    ran = [r for r in rs if r['verdict'] != 'NO RUN']
    d = [r for r in ran if r['kind'] == 'defect']; c = [r for r in ran if r['kind'] == 'clean']
    exp = sum(int(r['detected'].split('/')[1]) for r in d); got = sum(int(r['detected'].split('/')[0]) for r in d)
    secs = [r['seconds'] for r in ran if r['seconds']]
    costs = [r['cost'] for r in ran if r['cost'] is not None]
    return {
        'runs': len(ran), 'pass': sum(r['verdict'] == 'PASS' for r in ran),
        'defect_runs': len(d), 'expected_defects': exp, 'detected_defects': got,
        'defect_cases_fully_caught': sum(r['detected'].split('/')[0] == r['detected'].split('/')[1] for r in d),
        'defects_blocked': sum(r['outcome'] == 'changes-requested' for r in d),
        'clean_runs': len(c), 'clean_blocked': sum(r['outcome'] == 'changes-requested' for r in c),
        'clean_serious_findings': sum(r['serious'] or 0 for r in c),
        'findings': sum(r['findings'] or 0 for r in ran), 'schema_invalid_findings': sum(r['schema_invalid'] for r in ran),
        'verified_steps': sum(r['verified_steps'] or 0 for r in ran),
        'seconds_median': statistics.median(secs) if secs else None, 'seconds_mean': round(statistics.mean(secs), 1) if secs else None,
        'seconds_total': sum(secs), 'cost_total': round(sum(costs), 2), 'cost_mean': round(statistics.mean(costs), 3) if costs else None,
        'turns_median': statistics.median([r['turns'] for r in ran if r['turns']]) if ran else None,
        'in_tokens': sum(r['in_tokens'] or 0 for r in ran), 'out_tokens': sum(r['out_tokens'] or 0 for r in ran),
        'reps': len({r['rep'] for r in ran}),
    }

summary = {}
for suite in sorted({r['suite'] for r in runs}):
    for mode in ('server', 'model'):
        rs = [r for r in runs if r['suite'] == suite and r['mode'] == mode]
        if rs: summary[f'{suite}/{mode}'] = summarize(rs)
per_case = {}
for r in runs:
    k = (r['suite'], r['id'], r['mode'])
    p = per_case.setdefault(k, {'suite': r['suite'], 'id': r['id'], 'kind': r['kind'], 'mode': r['mode'], 'reps': 0, 'pass': 0, 'detected': 0, 'expected': 0, 'blocked': 0, 'seconds': [], 'findings': [], 'schema_invalid': 0})
    p['reps'] += 1; p['pass'] += r['verdict'] == 'PASS'
    a, b = r['detected'].split('/') if r['detected'] else ('0', '0')
    p['detected'] += int(a); p['expected'] += int(b); p['blocked'] += r['outcome'] == 'changes-requested'
    p['seconds'].append(r['seconds']); p['findings'].append(r['findings']); p['schema_invalid'] += r['schema_invalid']
json.dump({'summary': summary, 'per_case': list(per_case.values()), 'runs': runs}, open(out_file, 'w'), indent=1)
print(json.dumps(summary, indent=1))
