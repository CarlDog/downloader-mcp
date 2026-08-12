export const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// Matches a secret-bearing query param anywhere in a string — not just
// where a field happens to be named "url". Upstream APIs echo auth-bearing
// URLs into unexpected places (e.g. SABnzbd repeats the fetch URL, apikey
// included, inside history stage_log entries), so redaction has to scan by
// pattern rather than by field-name allowlist.
const SECRET_PARAM_RE =
  /([?&](?:api[-_]?key|passkey|token|secret|password)=)[^&\s"'<>]+/gi;

/**
 * Deep-walks a JSON-shaped value and strips secret query-param values from
 * every string, recursively. Single chokepoint: call this on every client
 * response before it reaches the tool layer, rather than redacting
 * field-by-field at each call site.
 */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(SECRET_PARAM_RE, "$1[REDACTED]") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}
