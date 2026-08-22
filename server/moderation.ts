/**
 * Hosted content moderation for user-supplied NAMES: account username, display name,
 * and the robot / team names embedded in a persisted leaderboard record. The server
 * is the AUTHORITY here — any client value is spoofable via devtools — so every
 * deliberate name claim (`server/api.ts`) and every durable public write
 * (`server/persist.ts`) runs through `moderateName()`.
 *
 * We call a HOSTED moderation model rather than shipping a hand-maintained wordlist:
 * the service tracks slurs, obfuscation, and new terms far better than a static list
 * and needs no upkeep. Defaults to OpenAI's free Moderation endpoint
 * (`POST /v1/moderations`, model `omni-moderation-latest`), but the endpoint, model,
 * and auth are env-configurable so it can point at any provider that speaks the same
 * request/response shape.
 *
 * ENV (all optional — absent ⇒ moderation is DISABLED and every name is allowed,
 * exactly the way `DATABASE_URL` gates the leaderboard):
 *   MODERATION_API_KEY    bearer token for the service (falls back to OPENAI_API_KEY)
 *   MODERATION_API_URL    endpoint (default https://api.openai.com/v1/moderations)
 *   MODERATION_MODEL      model id (default omni-moderation-latest)
 *   MODERATION_TIMEOUT_MS request timeout (default 4000)
 *
 * POLICY — FAIL OPEN. If the service is unconfigured, unreachable, times out, or
 * errors, the name is ALLOWED and a warning is logged. Moderation is a guardrail with
 * a human backstop (the admin forced-rename in `src/ui/Admin.tsx`); locking every
 * player out during a provider outage is the worse failure. Decisions are cached
 * in-process so a repeated username-availability probe never re-bills the API.
 */

const API_KEY = process.env.MODERATION_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const API_URL = process.env.MODERATION_API_URL ?? 'https://api.openai.com/v1/moderations';
const MODEL = process.env.MODERATION_MODEL ?? 'omni-moderation-latest';
const TIMEOUT_MS = Number(process.env.MODERATION_TIMEOUT_MS ?? 4000);

/** true when a moderation service is configured; when false everything is allowed */
export const moderationEnabled = API_KEY.length > 0;

export interface ModerationResult {
  /** whether the name may be used */
  allowed: boolean;
  /** whether the service actually ran (false ⇒ disabled / empty / failed-open) */
  checked: boolean;
}

// bounded decision cache (normalized text → allowed). A plain Map with FIFO-ish
// eviction is plenty: the working set is tiny and entries are cheap booleans.
const cache = new Map<string, boolean>();
const CACHE_MAX = 2000;

function cacheSet(key: string, allowed: boolean): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, allowed);
}

/** POST the text to the moderation endpoint; resolve to whether it is ALLOWED
 *  (i.e. NOT flagged). Throws on a network / non-2xx / malformed response so the
 *  caller can fail open. */
async function callProvider(text: string): Promise<boolean> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`moderation HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ flagged?: boolean }> };
  const flagged = body.results?.[0]?.flagged;
  if (typeof flagged !== 'boolean') throw new Error('moderation: unexpected response shape');
  return !flagged;
}

/**
 * Decide whether `raw` is an acceptable name. Empty/whitespace and the
 * moderation-disabled case both resolve to allowed (length/emptiness is the caller's
 * own concern). Fails open on any provider error.
 */
export async function moderateName(raw: string): Promise<ModerationResult> {
  const text = (raw ?? '').trim();
  if (!text || !moderationEnabled) return { allowed: true, checked: false };

  const key = text.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return { allowed: cached, checked: true };

  try {
    const allowed = await callProvider(text);
    cacheSet(key, allowed);
    return { allowed, checked: true };
  } catch (err) {
    console.warn('[moderation] check failed — allowing:', err instanceof Error ? err.message : err);
    return { allowed: true, checked: false };
  }
}

/**
 * Return `raw` when it is acceptable, otherwise `fallback`. For the persistence path,
 * where a flagged robot/team name is silently replaced with a safe default rather
 * than rejected (a record is written off the hot path at match end — there is no user
 * to show an error to). `fallback` is trusted to be clean.
 */
export async function scrubName(raw: string | undefined | null, fallback: string): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) return typeof raw === 'string' ? raw : fallback;
  const { allowed } = await moderateName(raw);
  return allowed ? raw : fallback;
}
