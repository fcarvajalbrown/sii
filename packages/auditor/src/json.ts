// Deterministic JSON (ADR-043 §I5).
//
// A leaf module: no imports, imported by `ingest/` and `store/` alike. It lives here rather than
// inside either of them because both need it and `store/` must not depend on `ingest/` (the
// dependency runs the other way — `ingest/` writes into the artifact store).
//
// WHY IT MATTERS: two runs that receive semantically equal payloads must produce the SAME content
// hash, or artifact de-duplication breaks and the "nothing changed" signal — which is how the loop
// avoids re-extracting an unchanged F22 every night — becomes noise. Key order in a JS object
// follows insertion order, which follows whatever order SII happened to serialise its response in.

/** JSON with object keys sorted at every depth. Arrays keep their order — that is data. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
  return out;
}
