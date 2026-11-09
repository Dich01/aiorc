# Recording the rejection demo

The clearest thing AIOrc can show in 30 seconds is the server **refusing** a call
that does not follow the flow, then proving afterwards what ran. This script
drives MCP contract v2.1 with `curl` against a throwaway instance, so it can be
recorded with asciinema. The server messages quoted below are the strings the
engine returns (`src/orchestrator/engine.ts`, `src/orchestrator/engineCore.ts`);
re-run the script before recording and use what your instance prints.

## Setup, off camera

Use a scratch database so nothing touches your development or production data.

```bash
cd /path/to/AIOrc
export AIORC_DB_PATH=/tmp/aiorc-demo/aiorc.db PORT=3999

AIORC_ADMIN_EMAIL=demo@example.com AIORC_ADMIN_PASSWORD='demo-password-123' npm run admin:create
npm run harness:apply -- harnesses/code-review    # prints each project key once
npm run dev &                                     # API + UI on http://localhost:3999

K=aiorc_pk_...        # the key printed for code-review-pre-pr
U=http://localhost:3999
```

The demo uses the `code-review-pre-pr` project of the reference harness. Its
first agent, `scope`, has rule exits: the server picks the next step from the
output (`risk: "trivial"` ends the run at `skipped-trivial`, anything else goes
to the review fork). The client never chooses there.

Helper that prints the first lines of the answer and its `_meta`:

```bash
mcp() { curl -s -X POST $U/mcp -H 'Content-Type: application/json' -H "x-project-key: $K" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin);r=r.get("result",r);print("\n".join(r["content"][0]["text"].splitlines()[:6]) if "content" in r else r);print("meta:",json.dumps(r.get("_meta")))'; }

IN='{"input":{"repo":"acme/api","base_sha":"'$(printf 'a%.0s' {1..40})'","head_sha":"'$(printf 'b%.0s' {1..40})'","diff_sha256":"'$(printf 'c%.0s' {1..64})'","changed_files":["README.md"]}}'
```

## The recording

**Beat 1: the server hands over exactly one step.**

```bash
mcp workflow.start "$IN"
```

The answer starts with `# AIOrc: server-orchestrated workflow` and dispatches
step 1 (`scope`) with its output schema. Capture `_meta.runId` into `R`.

**Beat 2: the client tries to pick the path itself. The server refuses.**

```bash
mcp workflow.next '{"runId":"'$R'","step":1,"outputs":[{"node":"scope","output":{"risk":"high","areas":["auth"],"reasons":"touches login"}}],"transition":"e-review"}'
```

> Rejected: the next step is decided by the server from your output; do not send `transition`.
>
> The run is still at step 1 and nothing was consumed. ...

A made-up edge id on a node whose exits the client does choose is refused the
same way (`"<id>" is not an edge id leaving this step. Allowed: ...`), and so is
an output that does not match the agent's schema.

**Beat 3: the legal call.** Same step, a valid output, no `transition`:

```bash
mcp workflow.next '{"runId":"'$R'","step":1,"outputs":[{"node":"scope","output":{"risk":"trivial","areas":[],"reasons":"docs only"}}]}'
```

> Workflow completed: reached End "skipped-trivial". Report the result to the user.

The server evaluated the rule edge `e-trivial` on the output and closed the run.

**Beat 4: the signed export, verified offline.**

```bash
curl -s "$U/api/runs/$R/export" -H "x-project-key: $K" > export.json
curl -s "$U/audit/keys" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["public_key_pem"])' > aiorc-public.pem
npm run audit:verify -- export.json --key aiorc-public.pem
```

`audit:verify` prints `VALID  run <id>  status=completed  outcome=skipped-trivial ...`.
The export (`aiorc.audit.v2`) carries the hash-chained events, including the
`step.completed` and `transition.taken` (`decided_by: "rule"`) of beat 3, the
frozen agent hashes and the accepted output. The rejected call of beat 2 left
no event: nothing was consumed.

## Model-orchestrated mode (optional, for contrast)

Switch the project in **Settings → Execution mode** (or
`PATCH /projects/:id/execution-mode {"mode":"compiled"}` with a session token).
The same `workflow.start` now returns the whole flow in one document
(`# AIOrc: model-orchestrated workflow (self-declared)`) with
`_meta.status: "delivered"`. The model finishes with its own account:

```bash
mcp workflow.report '{"runId":"'$R2'","report":{"path":["scope"],"invocations_per_agent":{"scope":1},"ended_at":"End: skipped-trivial","final_summary":"docs only"}}'
```

> Report stored as self-declared (model-orchestrated mode: the server did not verify it).

The run is `reported`, never `completed`; Audit and Analytics label it
self-declared, and `audit:verify` adds `(self-declared report, not server-verified)`.
Switch the project back before recording anything else.

## Notes

- `workflow.next` with a step number other than the current one is refused too,
  and resending the last accepted call returns the same answer without advancing.
- If you re-record, start a new run: a finished run answers
  `This run has already completed. No further steps will run.`
