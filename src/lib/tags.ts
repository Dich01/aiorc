// Normalize a tags input (array or comma-separated string) into a clean,
// deduped, comma-separated string. Caps individual tag length and total count.
// Shared by projects, agents, skills and contexts.
export function normalizeTags(input: unknown): string {
  let raw: string[];
  if (Array.isArray(input)) raw = input.map(t => String(t));
  else if (typeof input === 'string') raw = input.split(',');
  else return '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const tag = t.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out.join(', ');
}
