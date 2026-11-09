import { FlowDocument } from '../../db/schema';

// Fixture mirrors the real crew shape, reduced:
//
//   start → brain
//   brain → verify         when: "the user asks for a diagnosis"
//   brain → P (parallel)   fallback
//   P → mem, P → struct    (fork: both mandatory)
//   mem → jira, struct → jira   fallback
//   jira → End:success     fallback
//   verify → End:verify    fallback

export const flow: FlowDocument = {
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'A', type: 'agent', agent_id: 'id-brain', agent_name: 'brain', x: 0, y: 0 },
    { id: 'B', type: 'agent', agent_id: 'id-verify', agent_name: 'verify', x: 0, y: 0 },
    { id: 'P', type: 'parallel', x: 0, y: 0 },
    { id: 'C', type: 'agent', agent_id: 'id-mem', agent_name: 'mem', x: 0, y: 0 },
    { id: 'D', type: 'agent', agent_id: 'id-struct', agent_name: 'struct', x: 0, y: 0 },
    { id: 'E', type: 'agent', agent_id: 'id-jira', agent_name: 'jira', x: 0, y: 0 },
    { id: 'end1', type: 'end', outcome: 'success', x: 0, y: 0 },
    { id: 'end2', type: 'end', outcome: 'verify done', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'A' },
    { id: 'e2', from: 'A', to: 'B', condition: 'the user asks for a diagnosis' },
    { id: 'e3', from: 'A', to: 'P' },
    { id: 'e4', from: 'P', to: 'C' },
    { id: 'e5', from: 'P', to: 'D' },
    { id: 'e6', from: 'C', to: 'E' },
    { id: 'e7', from: 'D', to: 'E' },
    { id: 'e8', from: 'E', to: 'end1' },
    { id: 'e9', from: 'B', to: 'end2' },
  ],
};

