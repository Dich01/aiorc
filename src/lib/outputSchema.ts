import Ajv, { ValidateFunction } from 'ajv';
import { formatAjvErrors } from '../mcp/validation';
import { hashJson } from './canonicalJson';

// Agent output contracts are JSON Schemas written by project owners. They are
// compiled server-side to validate what the model hands back, so they are
// bounded: a size cap, no remote or cross-document $ref (only "#..."), and no
// $id that could register a remote base URI.

export const MAX_OUTPUT_SCHEMA_BYTES = 32 * 1024;

// When an agent declares no schema, its output must still be a JSON object.
export const DEFAULT_OUTPUT_SCHEMA = { type: 'object' };

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
const cache = new Map<string, ValidateFunction>();

function findForbiddenRef(node: unknown, path = '#'): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const r = findForbiddenRef(node[i], `${path}/${i}`); if (r) return r; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if ((k === '$ref' || k === '$dynamicRef' || k === '$recursiveRef') && typeof v === 'string' && !v.startsWith('#')) {
      return `${path}/${k} points outside the schema ("${v}"); only local references ("#/...") are allowed`;
    }
    if (k === '$id' && typeof v === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(v)) {
      return `${path}/$id must not be an absolute URI`;
    }
    const r = findForbiddenRef(v, `${path}/${k}`);
    if (r) return r;
  }
  return null;
}

// Returns an error message, or null when the schema is acceptable.
export function checkOutputSchema(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'output_schema must be a JSON Schema object';
  const size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (size > MAX_OUTPUT_SCHEMA_BYTES) return `output_schema is too large (${size} bytes; the limit is ${MAX_OUTPUT_SCHEMA_BYTES})`;
  const ref = findForbiddenRef(schema);
  if (ref) return `output_schema: ${ref}`;
  try { compileOutputSchema(schema); } catch (err) { return `output_schema does not compile: ${(err as Error).message}`; }
  return null;
}

export function compileOutputSchema(schema: unknown): ValidateFunction {
  const key = hashJson(schema);
  let fn = cache.get(key);
  if (!fn) {
    // Compile a copy without $id so two agents with the same $id don't clash.
    const { $id: _id, ...rest } = schema as Record<string, unknown>;
    void _id;
    fn = ajv.compile(rest);
    if (cache.size > 500) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

export function validateOutput(schema: unknown | null, output: unknown): string | null {
  const fn = compileOutputSchema(schema ?? DEFAULT_OUTPUT_SCHEMA);
  return fn(output) ? null : formatAjvErrors(fn.errors);
}

export function parseStoredSchema(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
