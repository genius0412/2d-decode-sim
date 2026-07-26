import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthReactAdapter } from '@neondatabase/auth/react/adapters';

/**
 * Neon Auth (Better Auth) client. One env var — `VITE_NEON_AUTH_URL` (the hosted
 * auth endpoint from the Neon dashboard → Auth tab). Absent ⇒ auth disabled and
 * the app runs exactly as before (solo/anonymous). The server attributes a run by
 * verifying the JWT from `getAuthToken()` (see server/auth.ts), so identity is
 * server-verified, not client-asserted.
 */

const url = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;

export const authEnabled = !!url;

/** the beta SDK's typed surface varies by adapter; the React adapter adds
 * `useSession`. A loose local type keeps our call sites honest without depending
 * on the beta d.ts shape. */
export interface NeonAuthUser {
  id: string;
  name?: string;
  email?: string;
}
export interface AuthClient {
  useSession: () => { isPending: boolean; data: { user: NeonAuthUser } | null };
  getSession: () => Promise<{ data: { user: NeonAuthUser } | null }>;
  signIn: {
    email: (c: { email: string; password: string }) => Promise<unknown>;
    social: (o: { provider: string; callbackURL?: string }) => Promise<unknown>;
  };
  signUp: { email: (c: { email: string; password: string; name: string }) => Promise<unknown> };
  signOut: () => Promise<unknown>;
  getJWTToken?: () => Promise<string | null>;
}

export const authClient: AuthClient | null = url
  ? (createAuthClient(url, { adapter: BetterAuthReactAdapter() }) as unknown as AuthClient)
  : null;

/**
 * The live JWT, cached in memory until it is nearly expired.
 *
 * Every authenticated call used to fetch a brand-new token first, and Neon Auth
 * serves `/token` by reading `session`, `user`, `jwks` and `project_config` out of
 * the SAME Postgres the game uses. With the friends panel polling on a timer that
 * came to roughly ten token fetches a minute per signed-in tab, each one a fresh
 * set of database reads for a token the previous request had already proved good.
 * On an otherwise empty site it was the largest single source of database traffic,
 * and it put a network round trip in front of every authenticated request.
 *
 * A JWT is a bearer credential with an expiry; reusing it until then is the whole
 * point of one. `exp` is read off the token rather than assumed, so this tracks
 * whatever lifetime Neon Auth issues without hardcoding it.
 */
let cachedToken: { token: string; expiresAtMs: number } | null = null;
/** renew this far ahead of `exp` so a token cannot expire in flight */
const TOKEN_REFRESH_SKEW_MS = 60_000;
/** only for a token with no readable `exp` — still ~10x fewer fetches than before */
const TOKEN_FALLBACK_TTL_MS = 60_000;

/** `exp` (ms) from a JWT payload, WITHOUT verifying it: the server checks the
 * signature, the client only needs to know when to ask for a new one. */
function expiryOf(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null; // unreadable ⇒ fall back to the short TTL, never fail a request
  }
}

/**
 * Drop the cached token. Called on sign-in and sign-out (the identity changed) and
 * on a 401 from our own API — a session revoked server-side leaves the cached token
 * stale even though it has not expired, and only a fresh fetch can discover that.
 */
export function clearAuthToken(): void {
  cachedToken = null;
}

/** the JWT the SERVER verifies to attribute a match to this user (null if signed
 * out or auth is off). `force` bypasses the cache, for a retry after a 401. */
export async function getAuthToken(force = false): Promise<string | null> {
  if (!url) return null;
  if (!force && cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
    return cachedToken.token;
  }
  // The SDK's getJWTToken() posts to a wrong route on this Neon Auth build
  // (`/get-j-w-t-token` → 404). The Better Auth JWT plugin serves a fresh JWT at
  // `GET ${authURL}/token` using the session cookie, so fetch that directly. The
  // server verifies it against the same JWKS (EdDSA).
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/token`, { credentials: 'include' });
    if (!res.ok) {
      console.log(`[auth] getAuthToken: /token → ${res.status} (signed out or CORS?)`);
      cachedToken = null;
      return null;
    }
    const data = (await res.json()) as { token?: string };
    const token = data.token ?? null;
    cachedToken = token
      ? { token, expiresAtMs: expiryOf(token) ?? Date.now() + TOKEN_FALLBACK_TTL_MS }
      : null;
    return token;
  } catch (e) {
    console.log('[auth] getAuthToken failed:', e);
    return null;
  }
}
