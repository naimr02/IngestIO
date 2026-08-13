/**
 * Log sanitization for worker stdout: masks credentials and API keys before
 * anything sensitive can reach the console or a log drain. Apply to every
 * message that includes error text, URLs, or extracted content.
 */

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const SUPABASE_SERVICE_KEY_RE = /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g;
const GENERIC_SECRET_RE = /\b(sk|pk|rk)_[A-Za-z0-9]{16,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const URL_CREDENTIALS_RE = /(\/\/)[^/@\s]+@/g;
const QUERY_SECRET_RE = /([?&](?:key|token|api[_-]?key|secret|password)=)[^&\s]*/gi;

/**
 * Redact sensitive values from a log message. Accepts strings, `Error`s, and
 * arbitrary objects; always returns a single sanitized string.
 */
export function sanitizeMessage(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? `${value.name}: ${value.message}`
        : safeStringify(value);

  return raw
    .replace(URL_CREDENTIALS_RE, '$1***@')
    .replace(QUERY_SECRET_RE, '$1<redacted>')
    .replace(JWT_RE, '<jwt>')
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(GOOGLE_API_KEY_RE, '<google-api-key>')
    .replace(SUPABASE_SERVICE_KEY_RE, '<supabase-service-key>')
    .replace(GENERIC_SECRET_RE, '$1_<redacted>')
    .trim();
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
