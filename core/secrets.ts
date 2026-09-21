// Defense in depth before anything is committed or journaled (spec 7.5). The
// boundary is the private remote; this catches the common plaintext credential
// shapes. It does not see binaries or arbitrary sensitive prose.

export interface SecretHit {
  rule: string;
  line: number;
  excerpt: string;
}

const RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { rule: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "sk-api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "stripe-live-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { rule: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{6,}@/i },
];

const ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{12,})/gi;

const PLACEHOLDER = /^(?:<.*>|\$\{.*\}|\$[A-Z_]+|x+|\*+|\.+|changeme|example|redacted|your[-_].*|none|null|undefined)$/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function redact(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...${value.slice(-2)}`;
}

function scanLine(text: string, line: number): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { rule, pattern } of RULES) {
    const m = pattern.exec(text);
    if (m) hits.push({ rule, line, excerpt: redact(m[0]) });
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[1] ?? "";
    if (PLACEHOLDER.test(value) || entropy(value) < 3.5) continue;
    // A path or URL says where a secret lives, not what it is (real vault note:
    // "ClickUp token: ~/..."). URLs with embedded credentials have their own rule.
    if (/^(?:~|\.{1,2})?\//.test(value) || value.includes("://")) continue;
    if (hits.some((h) => h.line === line)) continue; // already reported by a specific rule
    hits.push({ rule: "credential-assignment", line, excerpt: redact(value) });
  }
  return hits;
}

export function scanText(text: string): SecretHit[] {
  return text.split("\n").flatMap((line, i) => scanLine(line, i + 1));
}

const C_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };

// git C-quotes a path holding control characters, prefix included: "b/a\nb.md".
export function unquoteGitPath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      // By code point: an astral character (an emoji) is two UTF-16 units, and
      // encoding each half alone would produce replacement bytes.
      const ch = String.fromCodePoint(body.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(ch, "utf8"));
      i += ch.length - 1;
      continue;
    }
    const next = body[++i] ?? "";
    const simple = C_ESCAPES[next];
    if (simple !== undefined) bytes.push(simple);
    else if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(...Buffer.from(next, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function diffPath(header: string): string | null {
  // git ends a name holding a space with a TAB; only that TAB goes, never the
  // name's own spaces ("x/trailing " is a different file from "x/trailing").
  const raw = header.slice(4).replace(/\t$/, "");
  if (raw === "/dev/null") return null;
  return unquoteGitPath(raw).replace(/^b\//, "");
}

// Scans only added lines of a unified diff (git diff --cached -U0), by file.
export function scanDiff(diff: string): Map<string, SecretHit[]> {
  const byFile = new Map<string, SecretHit[]>();
  let file: string | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = diffPath(line);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (file === null) continue;
    if (line.startsWith("+")) {
      const hits = scanLine(line.slice(1), newLine);
      if (hits.length) byFile.set(file, [...(byFile.get(file) ?? []), ...hits]);
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    }
  }
  return byFile;
}
