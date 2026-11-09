import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

// One Ajv instance for the MCP surface. Tool argument schemas are the same
// objects advertised in tools/list, so what a client is told and what the
// server enforces can never drift apart.
export const ajv = new Ajv({ allErrors: true, strict: false });

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'invalid value';
  return errors.slice(0, 5).map(e => {
    const where = e.instancePath || '(root)';
    if (e.keyword === 'additionalProperties') return `${where}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    if (e.keyword === 'required') return `${where}: missing field "${(e.params as { missingProperty: string }).missingProperty}"`;
    return `${where} ${e.message ?? 'is invalid'}`;
  }).join('; ');
}

// JSON-RPC 2.0 request envelope.
export const validateEnvelope: ValidateFunction = ajv.compile({
  type: 'object',
  required: ['jsonrpc', 'method'],
  properties: {
    jsonrpc: { const: '2.0' },
    id: { type: ['string', 'integer', 'null'] },
    method: { type: 'string', minLength: 1, maxLength: 200 },
    params: { type: ['object', 'array'] },
  },
});

export const validateToolCallParams: ValidateFunction = ajv.compile({
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    arguments: { type: 'object' },
    _meta: { type: 'object' },
  },
});
