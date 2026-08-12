import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Server-side Neon Auth (Better Auth) session verification. The client sends the
 * JWT from `getAuthToken()` on `join`; we verify its signature against Neon Auth's
 * JWKS and read the subject as the user id. SECURE BY DEFAULT: a missing/invalid
 * token ⇒ null ⇒ the run is anonymous (dropped by persistMatch), never trusted.
 *
 * Config (server env — set as Fly secrets, NOT VITE_):
 *   NEON_AUTH_URL   the same base as the client's VITE_NEON_AUTH_URL
 *   NEON_AUTH_JWKS_URL  (optional) override the JWKS endpoint if Neon's differs
 *     from the Better Auth default `${NEON_AUTH_URL}/jwks`.
 *
 * NOTE (beta): the exact JWKS path + claim names should be confirmed against a
 * live token once (log a decoded token). Until the JWKS URL resolves, verify()
 * returns null and everything degrades to anonymous — no crash, no bad writes.
 */

const AUTH_URL = process.env.NEON_AUTH_URL;
// Neon Auth (Better Auth) publishes its JWKS at `${authURL}/.well-known/jwks.json`
// (EdDSA/Ed25519 keys) — verified against the live endpoint. Override with
// NEON_AUTH_JWKS_URL if it ever moves.
const JWKS_URL =
  process.env.NEON_AUTH_JWKS_URL ??
  (AUTH_URL ? `${AUTH_URL.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);

// Build the JWKS set defensively: a malformed NEON_AUTH_URL would make `new URL()`
// THROW at module load — and since this module is imported before `httpServer.listen()`,
// that throw crashes the whole process at boot (nothing binds → Fly reports "app not
// listening on 0.0.0.0:8080"). Degrade to anonymous instead of taking the server down.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
if (JWKS_URL) {
  try {
    jwks = createRemoteJWKSet(new URL(JWKS_URL));
  } catch (e) {
    console.error(`[auth] invalid NEON_AUTH_URL/JWKS_URL (${JWKS_URL}) — all runs anonymous:`, e);
  }
}
export const authConfigured = !!jwks;

console.log(
  `[auth] ${authConfigured ? `JWKS ${JWKS_URL}` : 'auth not configured — all runs anonymous'}`,
);

export interface AuthedUser {
  userId: string;
  handle: string;
}

/** verify a client-supplied JWT → {userId, handle}, or null if absent/invalid */
export async function verifyAuthToken(token: string | undefined): Promise<AuthedUser | null> {
  if (!token) {
    console.log('[auth] verify: no token on join ⇒ anonymous');
    return null;
  }
  if (!jwks) {
    console.log('[auth] verify: JWKS not configured ⇒ anonymous');
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks);
    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!userId) {
      console.log('[auth] verify: token has no `sub` claim; claims=', Object.keys(payload).join(','));
      return null;
    }
    const name = payload.name ?? payload.email ?? undefined;
    // Deliberately NOT logged. The friends read doubles as the presence heartbeat, so
    // every signed-in browser tab re-verifies roughly twice a minute for as long as it
    // is open — a success line here meant an idle server with two users online emitted
    // thousands of identical lines a day, which is both the bulk of the log bill and the
    // noise that buries the failures below (the ones that actually explain a player being
    // silently signed out). Failures and misconfiguration still log; success is the
    // uninteresting case and is now silent.
    return { userId, handle: typeof name === 'string' && name ? name : 'Player' };
  } catch (e) {
    // expired / bad signature / unreachable-or-wrong JWKS ⇒ anonymous. Log why.
    console.log('[auth] verify FAILED:', e instanceof Error ? e.message : e);
    return null;
  }
}
