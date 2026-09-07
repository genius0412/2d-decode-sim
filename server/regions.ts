/**
 * Region topology for multi-region matchmaking (one Fly app, one machine per
 * region). This module is server infra — NOT `src/sim` — so wall-clock and plain
 * data are fine here; nothing in it feeds the deterministic step().
 *
 * The matchmaker never pings regions itself. Each client reports its `homeRegion`
 * (the region Fly's Anycast routed it to, read from the `/health` `x-region`
 * header) plus one measured `accessMs` (RTT to that home machine). We estimate the
 * client's latency to any OTHER region as `accessMs + INTER_REGION_MS[home][r]`,
 * using a static inter-region RTT matrix. The fair host for a group is the region
 * that MINIMISES the worst player's latency (minimax) — i.e. roughly "in the
 * middle", so nobody eats the whole cross-region penalty.
 */

/** the regions we actually deploy a machine to (keep in sync with `fly scale`) */
export const DEPLOY_REGIONS = ['iad', 'ord', 'sjc', 'lhr', 'gru', 'jnb', 'syd', 'nrt'] as const;
export type Region = (typeof DEPLOY_REGIONS)[number];

/** the always-on machine that holds the global ranked queue (fly-replay target for
 * `?mm=1` connections). Override per-deploy with MATCHMAKER_REGION. */
export const MATCHMAKER_REGION: string = process.env.MATCHMAKER_REGION ?? 'iad';

/**
 * Static, symmetric inter-region RTT in milliseconds (diagonal = 0). MEASURED
 * 2026-07-08 machine-to-machine over Fly's 6PN mesh (TCP handshake to each region's
 * hallpass), symmetric averages rounded. Re-measure + retune when the region set or
 * Fly's backbone changes (see docs/deploy.md). Only relative ordering matters for
 * host selection, so small drift is harmless.
 *
 * ⚠️ THE `ord`, `gru` AND `jnb` ROWS ARE ESTIMATED, NOT MEASURED (2026-09-06). The
 * satellites `auto_stop`, so by the time these regions were added they were refusing
 * connections and the 6PN handshake measured cold-boot time rather than RTT — 2.1s to
 * a stopped iad. The figures below are geographic, and checked for consistency against
 * the measured rows: Chicago sits between iad and sjc (20/50 inside their measured 85),
 * further from London than iad is (95 > 76), and between sjc and iad for both Pacific
 * hops (109 < 150 < 164, 148 < 180 < 190). São Paulo and Johannesburg are checked the
 * same way against the triangle their measured neighbours give: gru→ord (135) stays
 * under gru→iad + iad→ord (135), jnb→iad (230) under jnb→lhr + lhr→iad (236), and the
 * two of them are 340 apart across the South Atlantic — the one hop with no northern
 * detour, which is why it beats jnb→lhr→gru (350). Good enough for an ordering, but
 * re-measure with every region WARM and replace these.
 */
const RTT: Record<string, Record<string, number>> = {
  iad: { iad: 0, ord: 20, sjc: 85, lhr: 76, gru: 115, jnb: 230, syd: 190, nrt: 164 },
  ord: { ord: 0, iad: 20, sjc: 50, lhr: 95, gru: 135, jnb: 245, syd: 180, nrt: 150 },
  sjc: { sjc: 0, ord: 50, iad: 85, lhr: 133, gru: 180, jnb: 290, syd: 148, nrt: 109 },
  lhr: { lhr: 0, ord: 95, iad: 76, sjc: 133, gru: 190, jnb: 160, syd: 251, nrt: 236 },
  gru: { gru: 0, ord: 135, iad: 115, sjc: 180, lhr: 190, jnb: 340, syd: 310, nrt: 260 },
  jnb: { jnb: 0, ord: 245, iad: 230, sjc: 290, lhr: 160, gru: 340, syd: 390, nrt: 360 },
  syd: { syd: 0, ord: 180, iad: 190, sjc: 148, lhr: 251, gru: 310, jnb: 390, nrt: 114 },
  nrt: { nrt: 0, ord: 150, iad: 164, sjc: 109, lhr: 236, gru: 260, jnb: 360, syd: 114 },
};

/** inter-region RTT (ms). Unknown regions fall back to a large penalty so an
 * unrecognised `homeRegion` never looks like a good host. */
export function interRegionMs(a: string, b: string): number {
  if (a === b) return 0;
  return RTT[a]?.[b] ?? RTT[b]?.[a] ?? 300;
}

/** one participant's reported network position */
export interface PingInfo {
  homeRegion: string;
  accessMs: number;
}

/** estimated RTT from a participant to a candidate host region */
export function estimatePing(p: PingInfo, r: string): number {
  return p.accessMs + interRegionMs(p.homeRegion, r);
}

/**
 * The fair host region for a group: the deployed region that minimises the WORST
 * participant's estimated ping (minimax → the geographic "middle"), so nobody eats
 * the whole cross-region penalty. Returns:
 *  - `hostRegion`: where to run the authoritative match.
 *  - `cost`: the worst participant's estimated ping AT that host (fairness metric).
 *  - `spread`: the worst participant's INTER-REGION component at that host — 0 when
 *    everyone shares the host's region. This is what the search-radius gate uses, so
 *    the gate is about "how far cross-region we'll reach", independent of any one
 *    player's own local connection quality (which is baked into `accessMs`).
 * Ties break on the lower total ping (kinder overall), then region order (determinism).
 */
export function bestHost(group: PingInfo[]): { hostRegion: string; cost: number; spread: number } {
  let best: { hostRegion: string; cost: number; spread: number; sum: number } | null = null;
  for (const r of DEPLOY_REGIONS) {
    let worst = 0;
    let spread = 0;
    let sum = 0;
    for (const p of group) {
      const ms = estimatePing(p, r);
      if (ms > worst) worst = ms;
      const inter = interRegionMs(p.homeRegion, r);
      if (inter > spread) spread = inter;
      sum += ms;
    }
    if (!best || worst < best.cost || (worst === best.cost && sum < best.sum)) {
      best = { hostRegion: r, cost: worst, spread, sum };
    }
  }
  return best
    ? { hostRegion: best.hostRegion, cost: best.cost, spread: best.spread }
    : { hostRegion: MATCHMAKER_REGION, cost: 0, spread: 0 };
}
