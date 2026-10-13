/**
 * Hard block on the OpenAI "Sol" models (for example gpt-6-sol, gpt-6.1-sol).
 * Emysa must never send a request to one, whatever an env var, a caller
 * override or a stored setting says. A blocked name is swapped for the safe
 * fallback and a warning is logged; the request itself never carries it.
 *
 * Matches "sol" only as its own token, so "solid" or "console" are untouched.
 * Keep in sync with pipecat-service/app/config.py (is_blocked_model).
 */
const SOL = /(^|[^a-z0-9])sol($|[^a-z0-9])/;

export function isBlockedModel(name) {
  return SOL.test(String(name ?? '').toLowerCase());
}

export function allowedModel(name, fallback) {
  const n = String(name ?? '').trim();
  if (!n) return fallback;
  if (isBlockedModel(n)) {
    console.warn(`[model-guard] blocked model "${n}"; using "${fallback}" instead`);
    return fallback;
  }
  return n;
}
