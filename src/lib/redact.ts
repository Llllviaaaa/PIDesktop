const REDACTED = "[REDACTED]";

const KNOWN_CREDENTIAL = /(?:sk-(?:proj-|svcacct-|ant-|or-v1-)?[a-z0-9_-]{16,}|gsk_[a-z0-9]{16,}|github_pat_[a-z0-9_]{30,}|gh[pousr]_[a-z0-9]{20,}|aiza[0-9a-z_-]{30,}|(?:akia|asia)[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{10,}|hf_[a-z0-9]{20,}|npm_[a-z0-9]{20,}|pypi-[a-z0-9_-]{20,}|sg\.[a-z0-9_-]{10,}\.[a-z0-9_-]{20,})/gi;
const BEARER = /\b(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;
const QUOTED_SECRET = /(["'](?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)["']\s*:\s*["'])[^"']*(["'])/gi;
const ASSIGNED_SECRET = /\b(api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/gi;

export function redactSensitiveText(input: string): string {
  return input
    .replace(KNOWN_CREDENTIAL, REDACTED)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(QUOTED_SECRET, `$1${REDACTED}$2`)
    .replace(ASSIGNED_SECRET, `$1$2${REDACTED}`);
}
