# Deploying the multiplayer stack

Two independent deploys: the **client** (static, Vercel — unchanged) and the
**game server** (`server/`, a small always-on Node process). They are wired
together by one env var, `VITE_GAME_SERVER_URL`.

---

## Beginner quickstart — Fly.io game server (≈10 min)

Fly is CLI-driven; its **website** handles the account, billing, and dashboards, and a
handful of terminal commands do the deploy. You do **NOT** need Docker installed — Fly
builds the image on their servers.

**A. On the website (fly.io)**
1. Go to **https://fly.io** → **Sign Up** (email or GitHub). This creates an
   "organization" for you automatically.
2. Open the dashboard → **Billing** → **Add a payment method** (a card is required even
   for tiny usage — abuse prevention). One small always-on machine for this server is
   roughly **$2–5/month**.

**B. Install the Fly CLI (`flyctl`)** — one command in **PowerShell**:
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```
Close and reopen the terminal so `fly` is on your PATH. (Verify with `fly version`.)

**C. Log in** (opens your browser to confirm):
```powershell
fly auth login
```

**D. Pick a unique app name.** Open `fly.toml` (repo root) and change the first line —
app names are global, so `decode-game-server` is likely taken:
```toml
app = "decode-server-yourname"   # letters/numbers/dashes, must be unique
```
Also set `primary_region` to the code nearest your players (e.g. `iad` US-East,
`lax` US-West, `lhr` London, `syd` Sydney).

**E. Create + deploy** — run these from the project folder (`d:\Projects\2ddecodesim`):
```powershell
fly launch --no-deploy   # detects Dockerfile+fly.toml; when it asks to copy the existing config, say YES; skip Postgres/Redis
fly deploy               # builds + ships (first build ~2-3 min)
```

**F. Get your URL.** After deploy: `https://<your-app>.fly.dev`. Test the health check
in a browser — it should print `ok`:
```
https://<your-app>.fly.dev/health
```
Your client uses the **wss://** form: `wss://<your-app>.fly.dev`.

**G. Wire the client** (see §2 below): set `VITE_GAME_SERVER_URL=wss://<your-app>.fly.dev`
on Vercel and redeploy.

Useful later: `fly logs` (live output), `fly status` (machine health), `fly apps destroy
<app>` (tear it all down and stop billing).

### Prefer clicking to typing? (Render.com — fully web-based alternative)
If you'd rather not touch a terminal at all, **Render.com** deploys this same
`Dockerfile` straight from a GitHub repo through its website: New → **Web Service** →
connect the repo → it auto-detects the Dockerfile → set the env var `PORT` isn't even
needed (Render injects it) → Create. You get a `wss://<name>.onrender.com` URL to put in
`VITE_GAME_SERVER_URL`. (Render's free tier sleeps when idle and cold-starts on the next
connection; a paid instance stays warm — same tradeoff as Fly's `auto_stop`.) Railway
works the same way.

---

## 1. Game server → Fly.io (reference)

The server is a single stateless process (all match state lives in memory). Files:
`Dockerfile`, `fly.toml`, `.dockerignore` (repo root).

```bash
# one-time
fly launch --no-deploy        # pick a unique app name + region near your players
# every deploy (wrapper: deploys, then re-shrinks the satellite regions)
./scripts/fly-deploy.sh
```

- `fly.toml` exposes port 8080, forces HTTPS (so clients use `wss://`), auto-stops the
  machine when idle (`min_machines_running = 0`, `auto_stop_machines = 'stop'`) and
  auto-starts it on the next connection, and health-checks `GET /health` (with a 30s
  grace so a cold boot never flaps the machine). Set `min_machines_running = 1` to keep
  one machine warm and skip the first-connect cold start, at the cost of always-on
  billing for the warm machine.
- The Docker image is a 2-stage build: it esbuild-BUNDLES `server/index.ts` (+ the
  shared `src/sim`) to one plain-JS file, then runs it with plain `node`. This avoids
  transpiling the TS tree with `tsx` on every cold boot (~7s), so an auto_started
  machine is serving `/health` in well under a second.
- Your server URL is `wss://<app-name>.fly.dev`.
- Scale/CPU: the room loop runs a CONTINUOUS 60 Hz Rapier physics step. That is a
  sustained CPU workload, so the primary `iad` machine runs on `shared-cpu-4x` (4 shared
  vCPUs — enough parallel headroom that the 60 Hz loop never exhausts burst credits in
  practice; a smaller `shared-cpu-1x` throttles to a tiny baseline within a minute of play,
  stalling the event loop until even `/health` times out and the machine flaps "unhealthy").
  See fly.toml's COST-PASS note for the measured tradeoff vs. a dedicated `performance-1x`.
  `auto_stop_machines = 'stop'` +
  `min_machines_running = 1` keep ONE machine warm (the primary region = the
  designated `MATCHMAKER_REGION`, which ranked queueing routes to), while other regions
  idle to zero and cold-boot on first connect.

### Safe deploy — warn players, then deploy (`scripts/announce-deploy.sh`)

A bare deploy restarts the server process, dropping anyone mid-match. When players
may be online, deploy through the announce wrapper instead: it broadcasts a
`serverNotice` countdown banner to every connected client (and re-sends it to
anyone who joins during the window), waits, then runs `scripts/fly-deploy.sh` and
polls `/health`.

```bash
# one-time: authorize the announce endpoint from the CLI (no browser session)
fly secrets set ADMIN_SECRET='<random>' -a dohun-sim-decode

# every deploy when players may be online (5-min warning by default):
ADMIN_SECRET='<same value>' scripts/announce-deploy.sh "Server update — reconnecting shortly"
# custom wait (seconds); 0 = deploy immediately (use when /api/presence shows 0 online):
ADMIN_SECRET='<same value>' scripts/announce-deploy.sh "msg" 120
```

The `ADMIN_SECRET` must match the Fly secret of the same name; the announce endpoint
also accepts a signed-in admin's JWT (the Admin panel's "Announce restart" button does
the same thing manually). Check `GET /api/presence` first — if `online` is 0, you can
skip the wait. Keep `ADMIN_SECRET` out of git (it's only ever passed via env / the Fly
secret; never commit it).

### Multi-region (one app, one machine per region)

For a geographically spread player base, run the SAME app in several regions — this is
easier to manage than N separate apps and is what the client is built for (region-local
matchmaking + a fair-midpoint host via `fly-replay`; see `docs/netcodeplan.md` Phase 4).

```bash
./scripts/fly-deploy.sh                        # ship the image (NOT a bare `fly deploy` — see VM sizes below)
fly scale count 1 --region iad -a dohun-sim-decode   # one machine PER region
fly scale count 1 --region sjc -a dohun-sim-decode
fly scale count 1 --region lhr -a dohun-sim-decode
fly scale count 1 --region syd -a dohun-sim-decode
fly scale count 1 --region nrt -a dohun-sim-decode
fly secrets set MATCHMAKER_REGION=iad -a dohun-sim-decode   # holds the global ranked queue
```

- Keep it at **one machine per region** — two machines in one region re-split room/queue
  affinity (the matchmaker + rooms are in-process). The primary region stays warm
  (`min_machines_running = 1`); the rest auto-stop to ~$0 and wake on connect.
- Set `VITE_GAME_SERVERS` on Vercel to the region list, **all sharing the one app URL**
  (each entry differs only by `region`/`label`); the client adds a `?region=`/`?mm=`/`?room=`
  hint and the server `fly-replay`s the connection to the right region. See `.env.example`.
- Cross-region **ranked** also needs `DATABASE_URL` (the paired roster is staged in Postgres
  for the host machine). Region-local ranked and custom rooms do not.
- **`fly-replay` routing can only be verified on the deployed app** (the Fly proxy isn't in
  the loop on localhost) — after deploy, confirm a `?region=lhr` connection from the US lands
  on the `lhr` machine (`/api/presence` shows its region).
- **Per-region VM sizes + the deploy reset (IMPORTANT).** `iad` runs `shared-cpu-4x`
  /1024MB (the always-warm matchmaker; 4 shared vCPUs give the 60 Hz loop ample headroom
  without a dedicated vCPU's cost — see fly.toml's COST-PASS note); EVERY other region —
  `sjc` (joined 2026-07-20) plus the far satellites `lhr`/`syd`/`nrt` — runs the much cheaper
  `shared-cpu-1x`/1024MB. fly.toml has only ONE `[[vm]]`, and **`fly deploy` re-applies it
  (`shared-cpu-4x`) to every machine — silently UPSIZING the satellites off their cheap
  size.** So always deploy with **`scripts/fly-deploy.sh`** (deploy + re-shrink the
  satellites) rather than a bare `fly deploy`. Verify after: `fly machine list -a
  dohun-sim-decode` should show `iad` at `shared-cpu-4x:1024MB` and `sjc/lhr/syd/nrt` at
  `shared-cpu-1x:1024MB`.
- **Calibrating `INTER_REGION_MS`** (`server/regions.ts`): measure machine-to-machine RTT over
  Fly's 6PN mesh — from each region's machine, TCP-connect to another region's hallpass
  (`<region>.<app>.internal:22`, since the app binds IPv4-only so port 8080 isn't on 6PN) and
  time the handshake. Average both directions, drop into the matrix, redeploy. (Last measured
  2026-07-08.)

Any host that runs a container works (Railway, Render, a VPS with `npm ci --omit=dev &&
npm run server:start`); Fly is just the documented path. The only requirements are a
public TLS endpoint and a persistent process.

## 2. Client → Vercel

Add the env var and redeploy (baked in at build time):

```
VITE_GAME_SERVER_URL=wss://<app-name>.fly.dev
```

Absent ⇒ the MULTIPLAYER menu is hidden and the solo game is unaffected (mirrors the
old `supabaseConfigured()` gating). For the Electron build, set the same var in the
shell before `npm run dist`.

## 3. Local dev

```bash
npm run server      # tsx watch on ws://localhost:8787
# .env:  VITE_GAME_SERVER_URL=ws://localhost:8787
npm run dev         # Vite on http://localhost:5173
```

## Transport note — WebSocket now, WebTransport later

Phase 0/1 ship on **WebSocket** (universal, works everywhere including Safari and
Electron). The `Transport` interface (`src/net/transport.ts`) is the seam for a
**WebTransport** (HTTP/3 / QUIC unreliable-datagram) implementation, which trims tail
latency on lossy networks. It is deliberately **not** implemented yet: WebTransport
requires a valid TLS certificate + HTTP/3 and can only be exercised against a real
`https://` deployment (not localhost-without-certs), so it should be added and
validated **on the deployed Fly instance**, with automatic WebSocket fallback behind
the same interface. Client prediction already masks the occasional lost packet, so
WebSocket is fully playable in the meantime.

Note: today's snapshots are delta-encoded but assume the **ordered, reliable**
WebSocket (no per-packet ack). WebTransport datagrams are unreliable, so adding it also
means acking snapshots (the `ackInputTick` field is already plumbed for this) and
keying deltas off the last **acked** tick instead of the last **sent** tick.
