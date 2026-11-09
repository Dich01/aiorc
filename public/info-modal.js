// Shared "How to use AIOrc" info modal.
// On script load it injects the markup into the document body and exposes
// window.openInfoModal / closeInfoModal / switchInfoTab / copyInfoConfig.
(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('info-modal')) return; // already injected

  // Styles (only the bits that aren't in style.css). Most of these classes
  // already exist in dashboard.html / project.html — repeated here so the
  // modal looks identical wherever it's mounted.
  const style = document.createElement('style');
  style.textContent = `
    .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:2000; align-items:center; justify-content:center; padding:20px; }
    .modal-overlay.open { display:flex; }
    .modal-box { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; width:100%; max-width:520px; padding:28px 32px; max-height:90vh; overflow-y:auto; }
    .modal-box h3 { margin:0 0 4px; font-size:1.15rem; font-weight:700; }
    .modal-box .modal-subtitle { font-size:0.82rem; color:var(--muted); margin-bottom:18px; }
    .modal-footer { display:flex; gap:10px; margin-top:20px; justify-content:flex-end; }
    .info-modal-box { max-width:680px; }
    .info-tabs { display:flex; gap:2px; margin-bottom:20px; border-bottom:1px solid var(--border); overflow-x:auto; }
    .info-tab-btn { background:none; border:none; cursor:pointer; padding:8px 14px; font-size:0.85rem; color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s; font-family:inherit; white-space:nowrap; }
    .info-tab-btn.active { color:var(--primary); border-bottom-color:var(--primary); font-weight:600; }
    .info-tab-panel { display:none; }
    .info-tab-panel.active { display:block; }
    .info-steps { list-style:none; padding:0; margin:0; }
    .info-step { display:flex; gap:12px; margin-bottom:14px; align-items:flex-start; font-size:0.88rem; line-height:1.6; }
    .info-step-num { background:var(--primary); color:#fff; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-size:0.72rem; font-weight:700; flex-shrink:0; margin-top:1px; }
    .info-code { background:#0f172a; color:#e2e8f0; border-radius:8px; padding:14px 16px; font-family:'SFMono-Regular',Consolas,monospace; font-size:0.78rem; line-height:1.6; white-space:pre; overflow-x:auto; margin:10px 0; }
    .info-block { margin-bottom:18px; }
    .info-block h4 { font-size:0.92rem; font-weight:700; margin-bottom:6px; color:var(--text); display:flex; align-items:center; gap:8px; }
    .info-block-glyph { display:inline-flex; width:24px; height:24px; align-items:center; justify-content:center; border-radius:6px; font-weight:700; font-size:0.85rem; flex-shrink:0; }
    .glyph-decision { background:#fef3c7; color:#92400e; }
    .glyph-gate { background:#fee2e2; color:#b91c1c; }
    .glyph-loop { background:#d1fae5; color:#065f46; }
    .info-block p { font-size:0.86rem; line-height:1.65; color:var(--text); margin-bottom:6px; }
    .info-note { background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:10px 14px; font-size:0.82rem; color:#1e40af; line-height:1.55; }
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'info-modal';
  modal.addEventListener('click', e => { if (e.target === modal) window.closeInfoModal(); });
  modal.innerHTML = `
    <div class="modal-box info-modal-box">
      <h3>How to use AIOrc</h3>
      <p class="modal-subtitle">Control plane for AI agents, with server-enforced workflows over MCP — getting started guide.</p>

      <div class="info-tabs">
        <button class="info-tab-btn active" onclick="switchInfoTab('how')">Get started</button>
        <button class="info-tab-btn" onclick="switchInfoTab('config')">Configure target</button>
        <button class="info-tab-btn" onclick="switchInfoTab('blocks')">Control blocks</button>
      </div>

      <div id="info-tab-how" class="info-tab-panel active">
        <ol class="info-steps">
          <li class="info-step"><div class="info-step-num">1</div><span><strong>Define the agents</strong> — In the <em>Agents</em> tab, create one for each logical step. Each agent is a Markdown prompt. In server-orchestrated mode the model receives it when the flow reaches its step; in model-orchestrated mode it is part of the whole-flow prompt.</span></li>
          <li class="info-step"><div class="info-step-num">2</div><span><strong>Define skills (optional)</strong> — Skills are auxiliary documents (TDD, standards, security patterns) that appear in the flow builder panel and that agents can reference by name.</span></li>
          <li class="info-step"><div class="info-step-num">3</div><span><strong>Create a project</strong> — In <em>Projects</em>. Each project gets an id and a project key (<code>aiorc_pk_...</code>, for CI and runners); people connect with the project id and their own personal token.</span></li>
          <li class="info-step"><div class="info-step-num">4</div><span><strong>Build the flow</strong> — Open the project → <em>Flow Builder</em>. Drag agents from the left panel and connect them. Branch with natural-language conditions on the edges; fork with <em>Parallel</em>; iterate with back-edges.</span></li>
          <li class="info-step"><div class="info-step-num">5</div><span><strong>Save</strong> — The flow is validated and persisted. If there are structural errors, they are listed in a dialog and saving is blocked.</span></li>
          <li class="info-step"><div class="info-step-num">6</div><span><strong>Configure the target project</strong> — Add <code>.mcp.json</code> + rule in <code>CLAUDE.md</code> (next tab).</span></li>
          <li class="info-step"><div class="info-step-num">7</div><span><strong>Done</strong> — When Claude receives a task it calls <code>workflow.start</code>. In <strong>server-orchestrated mode</strong> (default) the server hands it one step at a time, validating each output and deciding or checking each transition, until the flow reaches an End. In <strong>model-orchestrated mode</strong> it receives the whole flow at once and finishes with <code>workflow.report</code>, a self-declared report.</span></li>
        </ol>
      </div>

      <div id="info-tab-config" class="info-tab-panel">
        <div class="info-block">
          <h4>1. <code style="font-size:0.85em">.mcp.json</code> file at the root of the target project</h4>
          <p>Tells Claude (Claude Code, Cursor or any MCP client) how to connect to the AIOrc server.</p>
          <div class="info-code" id="mcp-config-snippet">{
  "mcpServers": {
    "aiorc-&lt;project&gt;": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/AIOrc/mcp-bridge.js"],
      "env": {
        "AIORC_PROJECT_ID": "&lt;project id&gt;",
        "AIORC_TOKEN": "\${AIORC_TOKEN}",
        "AIORC_URL": "${location.origin}/mcp"
      }
    }
  }
}</div>
          <button class="btn btn-sm btn-ghost" onclick="copyInfoConfig()">Copy .mcp.json</button>
        </div>

        <div class="info-block">
          <h4>2. Rule in the target project's <code style="font-size:0.85em">CLAUDE.md</code></h4>
          <p>Tells the model to <em>always</em> start with <code>workflow.start</code>. Without this rule, Claude may ignore AIOrc.</p>
          <div class="info-code">## AIOrc: &lt;project name&gt;

Server: \`aiorc-&lt;project&gt;\` (AIOrc project "&lt;project name&gt;").
Use it for: &lt;project description&gt;

When a task fits that use, start it by calling \`workflow.start\` on the
\`aiorc-&lt;project&gt;\` server, not on another AIOrc server. NEVER respond with a
direct solution for those tasks without going through the workflow.
Do exactly what workflow.start returns: either ONE step at a time, advanced
with \`workflow.next\`, or the whole flow, finished with \`workflow.report\`.
Never skip steps or modify them with your own judgment.</div>
        </div>

        <div class="info-note">
          Replace <code>/absolute/path/to/AIOrc/mcp-bridge.js</code> with the real path, <code>aiorc-&lt;project&gt;</code> with the server name and <code>&lt;project id&gt;</code> with the project id. Each person exports their own personal token (<code>export AIORC_TOKEN=aiorc_pat_...</code>, created in their profile), so the file can be committed. The project's <em>Connect AI</em> tab generates both snippets for you.
        </div>
      </div>

      <div id="info-tab-blocks" class="info-tab-panel">
        <p style="font-size:0.86rem;color:var(--muted);margin-bottom:18px">Decision, Gate and Loop are not separate node types — they are patterns built from plain agent nodes plus edges with conditions, priorities and back-edges. The only structural nodes besides Start/End are <strong>Parallel</strong> forks, whose branches ALL execute.</p>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-decision">◇</span> Decision — content-based branching</h4>
          <p><em>Pattern:</em> an agent followed by several outgoing edges with natural-language conditions. The client picks exactly one edge by its id (the server rejects any other); an edge without a condition is the fallback. For deterministic branching use rule edges (harness or API), which the server evaluates in priority order.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> branch between agents (bug-resolver vs. new-fix), skip optional steps, pick a tool based on task type.</p>
        </div>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-gate"><svg class="i" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2.8h6l4.2 4.2v6L13 17.2H7L2.8 13V7z"/><path d="M7 10h6"/></svg></span> Gate — mandatory verdict</h4>
          <p><em>Pattern:</em> the agent emits a literal verdict (PASS / FAIL / score ≥ X) and its outgoing edges carry conditions matching that verdict. Same structure as a branch — the verdict text is the condition.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> after code-reviewer, security-qa, quality-gate, or any agent that returns a structured verdict.</p>
        </div>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-loop">↻</span> Loop — capped iteration</h4>
          <p><em>Pattern:</em> an edge pointing back to a previous agent (back-edge). Cycles are legal by construction; each agent node carries <code>max_invocations</code> (default 10, max 50) which caps the repetition. In server-orchestrated mode the server enforces the cap itself.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> review→fix→review until it passes, iterative refactor, test retries up to the node's cap.</p>
        </div>

        <div class="info-note">
          The patterns combine freely (loops inside branches, gates after forks). The server (<code>workflow.start</code> / <code>workflow.next</code>) validates every step's output, decides rule-based transitions and checks every other one against the graph, and enforces the per-node caps.
        </div>
      </div>

      <div class="modal-footer">
        <a href="faq.html" class="btn btn-ghost btn-sm">Full documentation →</a>
        <button class="btn btn-primary" onclick="closeInfoModal()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  window.openInfoModal = function () {
    window.switchInfoTab('how');
    modal.classList.add('open');
  };
  window.closeInfoModal = function () { modal.classList.remove('open'); };
  window.switchInfoTab = function (name) {
    ['how', 'config', 'blocks'].forEach((t, i) => {
      const panel = document.getElementById('info-tab-' + t);
      const btn = modal.querySelectorAll('.info-tab-btn')[i];
      if (panel) panel.classList.toggle('active', t === name);
      if (btn) btn.classList.toggle('active', t === name);
    });
  };
  window.copyInfoConfig = function () {
    const text = document.getElementById('mcp-config-snippet')?.textContent || '';
    navigator.clipboard.writeText(text);
  };

  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.closeInfoModal(); });
})();
