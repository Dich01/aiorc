export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  nickname: string;
  bio: string;
  avatar: string;
  role: string; // 'admin' | 'user'
  created_at: number;
  last_login: number | null;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string;
  tags: string; // comma-separated labels for identifying/filtering projects (may be '')
  api_key_hash: string; // SHA-256 of the project key; the plaintext is shown once
  api_key_hint: string; // first characters of the key, for display only
  is_public: number; // 1 = listed in the repository and readable with x-project-id (runs still need the key)
  allow_executable_files: number; // 1 = non-Markdown files of agents/skills/contexts are delivered to the model
  input_schema: string; // JSON Schema (as JSON text) for workflow.start `input`, '' = none
  paused: number;    // 1 = kill switch on: new runs blocked (in-flight runs may finish)
  forked_from: string | null; // source project id if this is a fork
  created_at: number;
}

export interface UserToken {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  description: string;
  tags: string; // comma-separated labels (may be '')
  output_schema: string; // JSON Schema (as JSON text) the agent's output must satisfy, '' = any JSON object
  allowed_tools: string; // JSON array of external tool names ("server__tool" or "server__*") this agent may call
  is_public: number;
  forked_from: string | null;
  created_at: number;
}

export interface Skill {
  id: string;
  user_id: string;
  name: string;
  description: string;
  tags: string; // comma-separated labels (may be '')
  /** @deprecated Legacy single-blob content. New code reads/writes skill_files;
   *  this column is kept populated with the entry file's content for safe rollback. */
  content: string;
  is_public: number;
  forked_from: string | null;
  created_at: number;
}

// A skill is composed of N markdown files. Exactly one has is_entry=1 and is
// always named SKILL.md (Anthropic convention). The rest are supporting files
// the author can name freely; they're emitted after the entry when the skill
// is hoisted into a compiled workflow.
export interface SkillFile {
  id: string;
  skill_id: string;
  name: string;           // e.g. "SKILL.md", "domain.md"
  description: string;    // optional short description (may be '')
  content: string;
  is_entry: number;       // 1 for SKILL.md, 0 otherwise
  ordinal: number;        // display + emission order (entry always rendered first)
}

export interface Context {
  id: string;
  user_id: string;
  name: string;
  description: string;
  tags: string; // comma-separated labels (may be '')
  /** @deprecated Legacy single-blob content. New code reads/writes context_files;
   *  kept populated with the entry file's content for safe rollback. */
  content: string;          // markdown body — business know-how / documentation
  is_public: number;
  forked_from: string | null;
  created_at: number;
}

// Agents and contexts share the same file shape as SkillFile. Exactly one file
// has is_entry=1 (named AGENT.md / CONTEXT.md); the rest are supporting files of
// any extension, emitted after the entry when hoisted into a compiled workflow.
export interface EntityFile {
  id: string;
  name: string;
  description: string;
  content: string;
  is_entry: number;
  ordinal: number;
}

export interface AgentSkill {
  agent_id: string;
  skill_id: string;
  ordinal: number;
}

export interface ProjectAgent {
  project_id: string;
  agent_id: string;
}

export interface ProjectSkill {
  project_id: string;
  skill_id: string;
}

export interface ProjectContext {
  project_id: string;
  context_id: string;
  share_on_fork: number; // 0 = stays private to this project; 1 = copied to forks
}

export interface ProjectFlow {
  project_id: string;
  flow_json: string; // { nodes: FlowNode[], edges: FlowEdge[], max_iterations: number }
  updated_at: number;
}

// Flow model lives in src/shared/flow.ts (shared with the flow editor).
export type { FlowNodeType, FlowNode, FlowEdge, FlowDocument, Rule, RuleOp } from '../shared/flow';

export interface ProjectStar {
  user_id: string;
  project_id: string;
  created_at: number;
}

export interface AgentStar {
  user_id: string;
  agent_id: string;
  created_at: number;
}

export interface SkillStar {
  user_id: string;
  skill_id: string;
  created_at: number;
}

export interface ContextStar {
  user_id: string;
  context_id: string;
  created_at: number;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface ProjectInvitation {
  id: string;
  project_id: string;
  inviter_user_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  status: InvitationStatus;
  created_at: number;
  responded_at: number | null;
}

export interface AgentInvitation {
  id: string;
  agent_id: string;
  inviter_user_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  status: InvitationStatus;
  created_at: number;
  responded_at: number | null;
}

export interface SkillInvitation {
  id: string;
  skill_id: string;
  inviter_user_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  status: InvitationStatus;
  created_at: number;
  responded_at: number | null;
}

export interface ContextInvitation {
  id: string;
  context_id: string;
  inviter_user_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  status: InvitationStatus;
  created_at: number;
  responded_at: number | null;
}

export type IssueType = 'bug' | 'feature' | 'question';
export type IssueStatus = 'open' | 'closed';

export interface Issue {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: IssueType;
  status: IssueStatus;
  closed_by_user_id: string | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  user_id: string;
  body: string;
  created_at: number;
}

export interface IssueVote {
  user_id: string;
  issue_id: string;
  created_at: number;
}

// Who started a run: `caller` is verified (personal access token), the
// declared one comes from the x-user-email header and is never trusted.
export interface RunCaller {
  caller: { userId: string; email: string } | null;
  declaredCaller: string;
}

export interface Run {
  id: string;
  project_id: string;
  input: string;              // JSON string
  flow_json: string;          // normalized flow JSON at compile time (for path-aware skip analysis)
  outcome: string;            // End outcome reached ('' until the run completes)
  end_node: string;           // id of the End node reached ('' otherwise)
  caller_user_id: string;     // verified caller (personal access token), '' if none
  caller_email: string;       // verified caller's email, '' if none
  declared_caller: string;    // x-user-email header: self-declared, NOT verified
  mode: string;               // always 'stepped' (server-driven)
  engine_state: string;       // EngineState JSON
  eval_case_id: string;       // links the run to an eval case, '' for normal runs
  eval_verdict: string;       // '' | 'pass' | 'fail' — graded by the server on completion
  eval_reasons: string;       // JSON array of failure reasons, '' otherwise
  status: string;
  created_at: number;
}

// A test case for a project's flow: a fixed input plus deterministic acceptance
// criteria, graded from the run's event chain (see lib/evalGrading.ts).
export interface EvalCase {
  id: string;
  project_id: string;
  name: string;
  input: string;                 // JSON object fed to workflow.start
  expected_outcome: string;      // exact End outcome reached ('' = any End)
  must_complete_agents: string;  // JSON array: agents that must COMPLETE a step
  expected_findings: string;     // JSON array of matchers against the final output's findings
  max_extra_findings: number | null;
  created_at: number;
}

// Per-run agent usage telemetry. One row per (run, agent, source):
// - 'planned':  the agent is part of the run's flow.
// - 'executed': the agent completed a step: the server accepted an output
//   that validates against its output schema. Dispatch alone does not count.
export type AgentUsageSource = 'planned' | 'executed';

export interface AgentUsage {
  id: string;
  run_id: string;
  project_id: string;
  agent_id: string | null;  // null when a reported name can't be matched to a registered agent
  agent_name: string;
  source: AgentUsageSource;
  invocations: number;
  created_at: number;
}

// Bump whenever CREATE_TABLES_SQL changes in a way an existing database can't
// pick up through CREATE ... IF NOT EXISTS. There are no in-place migrations:
// a database at another version is refused at startup (see db/client.ts).
export const SCHEMA_VERSION = 6;

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  last_login INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname) WHERE nickname != '';

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT UNIQUE NOT NULL,
  api_key_hint TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  allow_executable_files INTEGER NOT NULL DEFAULT 0,
  input_schema TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_forked_from ON projects(forked_from);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  output_schema TEXT NOT NULL DEFAULT '',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_agents_forked_from ON agents(forked_from);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',  -- legacy column kept for safe rollback; new code reads/writes skill_files
  is_public INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_skills_forked_from ON skills(forked_from);

CREATE TABLE IF NOT EXISTS skill_files (
  id          TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  is_entry    INTEGER NOT NULL DEFAULT 0,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE (skill_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skill_files_skill ON skill_files(skill_id);

-- Agents and contexts use the same multi-file model as skills. The entry file
-- (is_entry=1) holds what used to live in the single content column
-- (AGENT.md / CONTEXT.md); supporting files of any extension follow it.
CREATE TABLE IF NOT EXISTS agent_files (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  is_entry    INTEGER NOT NULL DEFAULT 0,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE (agent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);

CREATE TABLE IF NOT EXISTS context_files (
  id          TEXT PRIMARY KEY,
  context_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  is_entry    INTEGER NOT NULL DEFAULT 0,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
  UNIQUE (context_id, name)
);
CREATE INDEX IF NOT EXISTS idx_context_files_context ON context_files(context_id);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);

CREATE TABLE IF NOT EXISTS project_agents (
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agents_agent ON project_agents(agent_id);

CREATE TABLE IF NOT EXISTS project_skills (
  project_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (project_id, skill_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id);
CREATE INDEX IF NOT EXISTS idx_project_skills_skill ON project_skills(skill_id);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_contexts_user ON contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_contexts_forked_from ON contexts(forked_from);

CREATE TABLE IF NOT EXISTS project_contexts (
  project_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  share_on_fork INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, context_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_contexts_project ON project_contexts(project_id);
CREATE INDEX IF NOT EXISTS idx_project_contexts_context ON project_contexts(context_id);

CREATE TABLE IF NOT EXISTS project_flows (
  project_id TEXT PRIMARY KEY,
  flow_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS project_stars (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stars_project ON project_stars(project_id);

CREATE TABLE IF NOT EXISTS agent_stars (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_stars_agent ON agent_stars(agent_id);

CREATE TABLE IF NOT EXISTS skill_stars (
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skill_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skill_stars_skill ON skill_stars(skill_id);

CREATE TABLE IF NOT EXISTS context_stars (
  user_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, context_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_stars_context ON context_stars(context_id);

CREATE TABLE IF NOT EXISTS agent_invitations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  FOREIGN KEY (invitee_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_invitations_agent ON agent_invitations(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_invitations_invitee_email ON agent_invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_agent_invitations_invitee_user ON agent_invitations(invitee_user_id);

CREATE TABLE IF NOT EXISTS skill_invitations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  FOREIGN KEY (invitee_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_skill_invitations_skill ON skill_invitations(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_invitations_invitee_email ON skill_invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_skill_invitations_invitee_user ON skill_invitations(invitee_user_id);

CREATE TABLE IF NOT EXISTS context_invitations (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  FOREIGN KEY (invitee_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_context_invitations_context ON context_invitations(context_id);
CREATE INDEX IF NOT EXISTS idx_context_invitations_invitee_email ON context_invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_context_invitations_invitee_user ON context_invitations(invitee_user_id);

CREATE TABLE IF NOT EXISTS project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  FOREIGN KEY (invitee_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_invitations_project ON project_invitations(project_id);
CREATE INDEX IF NOT EXISTS idx_invitations_invitee_email ON project_invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_invitations_invitee_user ON project_invitations(invitee_user_id);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'bug',
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_user_id TEXT,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (closed_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(type);
CREATE INDEX IF NOT EXISTS idx_issues_user ON issues(user_id);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);

CREATE TABLE IF NOT EXISTS issue_votes (
  user_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, issue_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_votes_issue ON issue_votes(issue_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  input TEXT NOT NULL,
  flow_json TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  end_node TEXT NOT NULL DEFAULT '',
  caller_user_id TEXT NOT NULL DEFAULT '',
  caller_email TEXT NOT NULL DEFAULT '',
  declared_caller TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  engine_state TEXT NOT NULL DEFAULT '',
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  eval_case_id TEXT NOT NULL DEFAULT '',
  eval_verdict TEXT NOT NULL DEFAULT '',
  eval_reasons TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Personal access tokens: identify WHO is calling /mcp (the project key only
-- says which project). Stored as SHA-256 hashes; shown once at creation.
CREATE TABLE IF NOT EXISTS user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_hint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);

-- Frozen copies of everything a run's prompts are built from, taken at
-- workflow.start. Steps are rendered from here, so editing or deleting an
-- agent, skill or context mid-run cannot change what the run executes.
CREATE TABLE IF NOT EXISTS run_snapshots (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'flow' | 'project' | 'agent' | 'skill' | 'context'
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, entity_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- Every accepted step output, whole (never truncated), with its hash.
CREATE TABLE IF NOT EXISTS run_step_outputs (
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  output_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step, node_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- Append-only, hash-chained audit log of every run. Each event's hash covers
-- the previous hash and the canonical JSON of the event, so changing,
-- removing or reordering any event breaks every hash after it. The triggers
-- make the table append-only at the database level. There is deliberately no
-- foreign key to runs: deleting a project removes its runs, not their history.
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER IF NOT EXISTS run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_project ON mcp_servers(project_id);

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  caller_user_id TEXT NOT NULL DEFAULT '',
  caller_email TEXT NOT NULL DEFAULT '',
  declared_caller TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_project ON mcp_tool_calls(project_id);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,                              -- JSON object fed to workflow.start
  expected_outcome TEXT NOT NULL DEFAULT '',        -- exact End outcome, '' = any End
  must_complete_agents TEXT NOT NULL DEFAULT '[]',  -- JSON array of agent names
  expected_findings TEXT NOT NULL DEFAULT '[]',     -- JSON array of finding matchers
  max_extra_findings INTEGER,                       -- NULL = no limit
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_project ON eval_cases(project_id);

CREATE TABLE IF NOT EXISTS agent_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT NOT NULL,
  source TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, agent_name, source),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_usage_project ON agent_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_usage_agent ON agent_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_usage_run ON agent_usage(run_id);
`;
