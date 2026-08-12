import { type GameServer } from './env';

/**
 * Pre-connection latency: measure OUR region, estimate the others.
 *
 * There is deliberately no "probe region X" function here any more. Such a probe
 * has to be fly-replayed to that region's machine, which BOOTS it (auto_start) —
 * so the old picker, which measured all five, woke every region on each visit and
 * kept them from auto-stopping. `probeHome` + `estimateAll` are the whole API.
 */

/** the client's own network position, for the ranked matchmaker: which region Fly's
 * Anycast routed us to (the `/health` `x-region` header) + our measured RTT there.
 * The matchmaker estimates our latency to every other region from these two values,
 * so we never have to ping each region separately (which CORS/`fly-prefer-region`
 * would make painful). `region` is '' if the server didn't send `x-region`. */
export interface HomeProbe {
  region: string;
  accessMs: number;
}

/** probe the connected server (over HTTP) for our home region + access latency.
 * `httpBase` is `gameServerHttpUrl()`. Returns null if the server is unreachable.
 *
 * The FIRST sample gets a much longer budget than the rest (`coldTimeoutMs`). Regions
 * auto-stop when idle, so the first request of a session is routinely the one that
 * WAKES the machine — measured at ~6 s from stopped to serving. Under the old flat 3 s
 * timeout every sample aborted before a waking region could answer, `probeHome` returned
 * null, and a perfectly healthy server was reported to the player as unreachable (the
 * region list greys out / multiplayer looks down) — a self-inflicted outage on exactly
 * the players whose region is least busy. Later samples keep the short timeout because
 * by then the machine is warm and they are measuring real latency; `best` takes the
 * MINIMUM, so the slow wake-up sample can never inflate the reported ping. If that first
 * generous attempt still times out, the server really is down — bail rather than making
 * the player wait out two more.
 */
export async function probeHome(
  httpBase: string,
  samples = 3,
  timeoutMs = 3000,
  coldTimeoutMs = 12000,
): Promise<HomeProbe | null> {
  const url = httpBase + '/health';
  let best: number | null = null;
  let region = '';
  for (let i = 0; i < samples; i++) {
    const ctl = new AbortController();
    const budget = i === 0 ? coldTimeoutMs : timeoutMs;
    const timer = setTimeout(() => ctl.abort(), budget);
    const t0 = performance.now();
    let ok = false;
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (res.ok) {
        ok = true;
        await res.text().catch(() => {});
        const rtt = performance.now() - t0;
        if (best === null || rtt < best) {
          best = rtt;
          region = res.headers.get('x-region') ?? region;
        }
      }
    } catch {
      /* unreachable / aborted */
    } finally {
      clearTimeout(timer);
    }
    if (i === 0 && !ok) return null; // nothing answered the generous probe ⇒ genuinely down
  }
  return best === null ? null : { region, accessMs: best };
}


/**
 * Estimated RTT to every configured server → { [id]: ms | null }.
 *
 * COST-CRITICAL: do NOT go back to measuring each region directly. A per-region
 * `/health?region=` probe is fly-replayed to that region's machine, and with
 * `auto_start_machines` that BOOTS it — so a picker that measured all five woke
 * all five on every visit and kept the satellites from ever staying stopped
 * (they are only cheap while stopped). Instead: probe our OWN region once (the
 * machine we'd use anyway) and estimate the others as `accessMs +
 * interRegionMs(home, r)`, exactly as the matchmaker does server-side. The RTT
 * matrix comes from `GET /api/regions` so it stays single-sourced in
 * `server/regions.ts`. Returns null for a region only if the home probe failed.
 */
export async function estimateAll(
  servers: GameServer[],
  httpBase: string,
): Promise<{ pings: Record<string, number | null>; homeRegion: string }> {
  const home = await probeHome(httpBase);
  if (!home) {
    return { pings: Object.fromEntries(servers.map((s) => [s.id, null])), homeRegion: '' };
  }
  let rtt: Record<string, Record<string, number>> = {};
  try {
    const res = await fetch(httpBase + '/api/regions', { cache: 'no-store' });
    if (res.ok) rtt = (await res.json()).rtt ?? {};
  } catch {
    /* no matrix → same-region is still exact, others fall back below */
  }
  const pings = Object.fromEntries(
    servers.map((s) => {
      if (!s.region || s.region === home.region) return [s.id, home.accessMs];
      // mirror interRegionMs()'s fallback: an unknown pair gets a large penalty
      // rather than looking artificially close.
      const hop = rtt[home.region]?.[s.region] ?? rtt[s.region]?.[home.region] ?? 300;
      return [s.id, home.accessMs + hop];
    }),
  );
  return { pings, homeRegion: home.region };
}

