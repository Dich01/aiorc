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
      <p class="modal-subtitle">Multi-agent workflow compiler over MCP — getting started guide.</p>

      <div class="info-tabs">
        <button class="info-tab-btn active" onclick="switchInfoTab('how')">Get started</button>
        <button class="info-tab-btn" onclick="switchInfoTab('config')">Configure target</button>
        <button class="info-tab-btn" onclick="switchInfoTab('blocks')">Control blocks</button>
      </div>

      <div id="info-tab-how" class="info-tab-panel active">
        <ol class="info-steps">
          <li class="info-step"><div class="info-step-num">1</div><span><strong>Define the agents</strong> — In the <em>Agents</em> tab, create one for each logical step. Each agent is a Markdown prompt that the target model will execute verbatim as a section of the compiled flow.</span></li>
          <li class="info-step"><div class="info-step-num">2</div><span><strong>Define skills (optional)</strong> — Skills are auxiliary documents (TDD, standards, security patterns) that appear in the flow builder panel and that agents can reference by name.</span></li>
          <li class="info-step"><div class="info-step-num">3</div><span><strong>Create a project</strong> — In <em>Projects</em>. An API key is generated (format <code>key-XXXX...</code>) that you will use in the target configuration.</span></li>
          <li class="info-step"><div class="info-step-num">4</div><span><strong>Build the flow</strong> — Open the project → <em>Flow Builder</em>. Drag agents from the left panel and connect them. For branching use <em>Decision</em>; for verdicts <em>Gate</em>; for iteration <em>Loop</em>.</span></li>
          <li class="info-step"><div class="info-step-num">5</div><span><strong>Save</strong> — The flow is validated and persisted. If there are structural errors, they are shown inline and saving is blocked.</span></li>
          <li class="info-step"><div class="info-step-num">6</div><span><strong>Configure the target project</strong> — Add <code>.mcp.json</code> + rule in <code>CLAUDE.md</code> (next tab).</span></li>
          <li class="info-step"><div class="info-step-num">7</div><span><strong>Done</strong> — When Claude receives a task, it will call <code>workflow(request)</code> and AIOrc returns a deterministic step-by-step mega-prompt.</span></li>
        </ol>
      </div>

      <div id="info-tab-config" class="info-tab-panel">
        <div class="info-block">
          <h4>1. <code style="font-size:0.85em">.mcp.json</code> file at the root of the target project</h4>
          <p>Tells Claude (Claude Code, Cursor or any MCP client) how to connect to the AIOrc server.</p>
          <div class="info-code" id="mcp-config-snippet">{
  "mcpServers": {
    "aiorc": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/AIOrc/mcp-bridge.js"],
      "env": {
        "AIORC_PROJECT_KEY": "key-XXXXXXXXXXXXXXXXXXXX",
        "AIORC_URL": "http://localhost:3000/mcp"
      }
    }
  }
}</div>
          <button class="btn btn-sm btn-ghost" onclick="copyInfoConfig()">Copy .mcp.json</button>
        </div>

        <div class="info-block">
          <h4>2. Rule in the target project's <code style="font-size:0.85em">CLAUDE.md</code></h4>
          <p>Tells the model to <em>always</em> call the <code>workflow</code> tool before responding.</p>
          <div class="info-code">## Mandatory rule

For any technical task (planning, implementation, code review,
security, quality, bugs), always call AIOrc's \`workflow\` tool
before responding. Never respond with a direct technical solution.

\`\`\`
workflow({
  request: "<task description>",
  context: "<optional context>"
})
\`\`\`</div>
        </div>

        <div class="info-note">
          Replace <code>/absolute/path/to/AIOrc/mcp-bridge.js</code> with the real path and <code>key-XX...</code> with the project's API key in AIOrc.
        </div>
      </div>

      <div id="info-tab-blocks" class="info-tab-panel">
        <p style="font-size:0.86rem;color:var(--muted);margin-bottom:18px">Three control flow primitives in addition to linear agents. They are dragged from the top bar of the Flow Builder.</p>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-decision">◇</span> Decision — content-based branching</h4>
          <p>Reads the output of the previous step and picks <strong>a single</strong> branch based on natural language conditions. Branches are evaluated in priority order; the first match wins.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> branch between agents (bug-resolver vs. new-fix), skip optional steps, pick a tool based on task type.</p>
        </div>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-gate">⛔</span> Gate — mandatory verdict</h4>
          <p>The previous agent must emit a literal verdict (PASS / FAIL / BLOCKED). The gate branches based on that token. <code>BLOCKED</code> ends the flow with a report; other verdicts continue down the corresponding branch.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> after code-reviewer, security-qa, quality-gate, or any agent that returns a structured verdict.</p>
        </div>

        <div class="info-block">
          <h4><span class="info-block-glyph glyph-loop">↻</span> Loop — capped iteration</h4>
          <p>Repeats the body steps up to N iterations (max 20) or until the exit condition is met. The back-edge is created automatically when the block is dropped.</p>
          <p style="font-size:0.82rem"><strong>When to use:</strong> review→fix→review until it passes, iterative refactor, test retries with backoff.</p>
        </div>

        <div class="info-note">
          The three blocks can be nested freely (loops inside decisions, gates inside loops). The compiler handles convergence and back-edges automatically.
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
