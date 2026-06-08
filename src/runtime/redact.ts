// Mask common secret shapes before text is written to a trace, echoed to the terminal, or persisted in state.json.
// Defence-in-depth, NOT the security boundary: a failed `git clone https://user:TOKEN@host` or a backend error
// that echoes an `Authorization` header must not leave a live credential on disk. Targeted (known token prefixes +
// `key=value`), so it redacts credentials without mangling ordinary ids/hashes. One responsibility: string in → string out.

const RULES: [RegExp, string][] = [
  // credentials embedded in a URL: scheme://user:SECRET@host
  [/(\bhttps?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, "$1«redacted»$2"],
  // Authorization: Bearer <token>  /  Basic <b64>
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/\-]{8,}=*/gi, "$1 «redacted»"],
  // provider token prefixes (OpenAI sk-/pk-, GitHub ghp_/…, Slack xox*, AWS AKIA, Google AIza)
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}\b/g, "«redacted-key»"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "«redacted-token»"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "«redacted-token»"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "«redacted-aws-key»"],
  [/\bAIza[0-9A-Za-z_\-]{27,}\b/g, "«redacted-key»"],
  // explicit secret assignment: api_key=… / token: "…" / password=… (keeps the key + quotes, masks the value)
  [/((?:api[_-]?key|secret|token|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[=:]\s*)(["']?)[^\s"'&]{6,}\2/gi,
    "$1$2«redacted»$2"],
];

/** Replace credential-shaped substrings with a redaction marker. Idempotent and cheap (a fixed set of regex passes). */
export function redact(s: string): string {
  let r = s;
  for (const [re, rep] of RULES) r = r.replace(re, rep);
  return r;
}
