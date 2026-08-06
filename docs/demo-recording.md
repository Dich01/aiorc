# Recording the rejection demo

The clearest thing AIOrc can show in 20 seconds is the server **refusing** a step that an LLM tried to skip. This is the script for recording that with asciinema. Every command here was executed against a clean instance and the output is what it actually printed.

The point of the recording is beat 3. Everything before it is setup, everything after it is proof.

## Record against a clean instance, not your own

The database lives at `$(pwd)/data/aiorc.db` — `src/db/client.ts` resolves it from the working directory. So running the server from a scratch directory gives you an isolated instance without touching your development database or production.

Do this before recording, off camera:

```bash
mkdir -p ~/aiorc-demo && cd ~/aiorc-demo

# Seeds automatically on first boot (src/index.ts calls seed() before listen).
PORT=3999 JWT_SECRET=demo \
  /path/to/AIOrc/node_modules/.bin/ts-node --transpile-only \
  /path/to/AIOrc/src/index.ts &

# Required: the seeded flows predate the mandatory Start node, so
# workflow.start rejects them until this runs. See issue #2.
/path/to/AIOrc/node_modules/.bin/ts-node --transpile-only \
  /path/to/AIOrc/src/migrate-add-start.ts

K=$(sqlite3 data/aiorc.db "SELECT api_key FROM projects WHERE name='Main Project'")
U=http://localhost:3999/mcp

# The audit export uses JWT auth, not the project key — two different
# mechanisms. Fetch the token now so no login noise appears on camera.
TOKEN=$(curl -s -X POST localhost:3999/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user1@aiorc.dev","password":"password123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

The example project is the seeded **Main Project**: a linear flow, `task-planner → backend-dev → security-qa`. Linear is the right choice — jumping to the last agent is unambiguously illegal, with no conditions to explain on camera.

## The helper

`workflow.start` returns over 1200 characters of agent instructions. Without truncation it floods the screen and the recording is unreadable. Define this before recording:

```bash
mcp() { curl -s -X POST $U -H 'Content-Type: application/json' -H "x-project-key: $K" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d["result"];print("\n".join(r["content"][0]["text"].splitlines()[:6]));print("meta:",json.dumps(r["_meta"]))'; }
```

## The recording

**Beat 1 — the server hands over exactly one agent.**

```bash
mcp workflow.start '{"request":"Add rate limiting to the login endpoint"}'
```

```
# AIOrc — stepped workflow (server-verified mode)

The server orchestrates this workflow: it hands you ONE step at a time and validates
every transition against the flow graph. Execute only what you are given.

## Execute this agent NOW
meta: {"runId":"...","mode":"stepped","done":false}
```

Capture the `runId` into `R`.

**Beats 2 and 3 — the client tries to jump to the last agent. The server refuses.**

```bash
mcp workflow.next "{\"runId\":\"$R\",\"output\":\"Plan ready\",\"next\":\"security-qa\"}"
```

```
Transition rejected: "security-qa" is not a legal transition from the current step.

Allowed transitions from the current step:
- → backend-dev (no condition — fallback)

The run is still open and no step was consumed. Call `workflow.next` again with the
same `runId` and `output`, setting `next` to one of the transitions above. Pass
`"next": "none"` if no condition matched.
```

This is the frame worth freezing on. `security-qa` is a real agent in the flow, and it is still refused, because it is not reachable from where the run currently is.

**Beat 4 — the legal path, through to End.**

```bash
mcp workflow.next "{\"runId\":\"$R\",\"output\":\"Plan ready\",\"next\":\"backend-dev\"}"
mcp workflow.next "{\"runId\":\"$R\",\"output\":\"Limiter in rateLimit.ts\",\"next\":\"security-qa\"}"
mcp workflow.next "{\"runId\":\"$R\",\"output\":\"No bypass found\",\"next\":\"none\"}"
```

The last call returns `Workflow completed` with `done=true`. Note that `security-qa` is accepted on the second call and was refused on the first — same agent, different position in the run.

**Beat 5 — the signed audit export.**

```bash
curl -s "localhost:3999/runs/$R/export" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("signature:",d["signature"][:32]+"...");print("algorithm:",d["algorithm"]);print("verified path:",[s["agent"] for s in d["payload"]["verified_execution"]["path"]])'
```

```
signature: 628010e6c7aa3ab30b0a12e479b6c3b1...
algorithm: HMAC-SHA256 over JSON.stringify(payload)
verified path: ['task-planner', 'backend-dev', 'security-qa']
```

Each step in `verified_execution.path` carries `{node, agent, at, output}`, so the summary typed into every `workflow.next` is inside the signed evidence. That is worth saying out loud if the recording has narration: the signature covers what actually ran, not a self-report written afterwards.

## Notes

- The signature verifies externally. Recompute `HMAC-SHA256(JSON.stringify(payload))` with the key in `.audit-secret` and it matches.
- The rejected hop is not wasted: state is persisted so the output summary survives, and no invocation is counted against the agent's cap.
- Total is five commands on camera. Editing the pauses out is usually enough to land under 30 seconds.
- If you re-record, use a fresh run. A completed `runId` answers `This run has already finished`, which is correct and not what you want on camera.
