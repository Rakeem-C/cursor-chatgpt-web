const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer|bearer)\s+[A-Za-z0-9._\-+/=]{12,}/g,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,}/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  redacted = redacted.replace(SECRET_PATTERNS[0]!, "[redacted-secret]");
  redacted = redacted.replace(SECRET_PATTERNS[1]!, "$1 [redacted-secret]");
  redacted = redacted.replace(SECRET_PATTERNS[2]!, "$1=[redacted-secret]");
  redacted = redacted.replace(SECRET_PATTERNS[3]!, "[redacted-jwt]");
  return redacted;
}
