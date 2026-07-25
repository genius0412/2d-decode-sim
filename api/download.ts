// Vercel EDGE function: proxy a desktop-release binary from the site's own
// domain so a download feels native — the browser never navigates to github.com
// (or the release-assets.githubusercontent.com CDN it redirects to).
//
// Reached via the `/download/:asset` rewrite in vercel.json. We fetch the GitHub
// "latest release" asset (following GitHub's 302 to its expiring signed CDN URL)
// and STREAM the body straight back with attachment headers. Edge runtime is used
// deliberately: it streams a response body without the 4.5 MB buffered-response
// cap of Node serverless functions, so 100–200 MB binaries pass through fine.
//
// Tradeoff (intentional, per product decision): every download's bytes flow
// through Vercel egress. For this niche app that's low volume, but a viral spike
// or a scraper would meter real bandwidth — revisit (CDN / direct link) if usage
// climbs. Range + HEAD are forwarded so browsers can resume and probe size.
export const config = { runtime: 'edge' };

const ALLOWED = new Set([
  'DSIM-Setup.exe',
  'DSIM-Portable.exe',
  'DSIM-mac.dmg',
  'DSIM-linux.AppImage',
]);

const RELEASE_BASE = 'https://github.com/genius0412/dsim/releases/latest/download/';

export default async function handler(req: Request): Promise<Response> {
  const asset = new URL(req.url).searchParams.get('asset') ?? '';
  // Strict allowlist — never proxy an arbitrary URL/path.
  if (!ALLOWED.has(asset)) {
    return new Response('Unknown download.', { status: 404 });
  }

  const range = req.headers.get('range');
  let upstream: Response;
  try {
    upstream = await fetch(RELEASE_BASE + encodeURIComponent(asset), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: range ? { range } : undefined,
      redirect: 'follow',
    });
  } catch {
    return new Response('Download temporarily unavailable.', { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    // 404 (no release yet / renamed asset) or an upstream hiccup.
    return new Response('Download unavailable.', { status: upstream.status === 404 ? 404 : 502 });
  }

  const headers = new Headers();
  headers.set('content-type', 'application/octet-stream');
  headers.set('content-disposition', `attachment; filename="${asset}"`);
  headers.set('accept-ranges', 'bytes');
  // NEVER cache at the edge. These are large streamed bodies and — critically —
  // we honour Range: a cached 206 partial served for a different (or full) request
  // would hand the user a TRUNCATED file. Always stream fresh from the origin.
  headers.set('cache-control', 'no-store');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('content-range', contentRange);

  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}
