#!/usr/bin/env bash
# Deploy the DECODE game server to Fly, then RE-APPLY the per-region VM sizes.
#
# Why this wrapper exists: `fly deploy` re-applies fly.toml's single `[[vm]]`
# (shared-cpu-4x) to EVERY machine, which resets the cheaper satellite regions.
# fly.toml has no way to express per-region VM sizes, so we shrink the satellites
# back here. ALWAYS deploy via this script, not a bare `fly deploy`.
#
# Sizing policy: iad (matchmaker + always-warm primary) runs shared-cpu-4x (from
# fly.toml — 4 shared vCPUs, ample headroom for the 60Hz loop without a dedicated
# vCPU's cost). EVERY other region, INCLUDING sjc, runs shared-cpu-1x — much cheaper,
# but SHARED: a sustained match there can burn burst
# credits and throttle the 60Hz loop (the flap risk fly.toml warns about). They rarely
# host a match and auto-stop when idle, so the cost win outweighs it; bump back to a
# performance-* size if a far region starts flapping under real matches. Tune below.
set -euo pipefail

APP="${FLY_APP:-dohun-sim-decode}"
# EVERY region except the always-warm primary (iad) runs the cheap shared size.
# sjc joined this list 2026-07-20 (cost pass): US West is redundant with iad for
# the ~75% of games that are solo record runs, and it auto-stops when idle anyway.
# ord (US Central) joined 2026-09-06 for the same reason it is cheap to have: a
# satellite costs nothing while it is stopped, and it only wakes when somebody in
# the middle of the country actually hosts a room there.
# gru (São Paulo) and jnb (Johannesburg) joined the same day, on the same logic:
# both continents were >200ms from EVERY existing region, which is the difference
# between playable and not. There is NO Middle East region on Fly — the nearest
# option for those players stays lhr, or fra if it is ever added here.
SATELLITES=(ord sjc lhr gru jnb syd nrt)
SATELLITE_SIZE=shared-cpu-1x
# MB. Was 1024, on the grounds that shared-cpu-1x's 256MB default is "too tight for
# Node+tsx+Rapier" — but the runtime stopped using tsx when the Dockerfile started
# esbuild-BUNDLING the server (`CMD ["node", "dist-server/index.js"]`), so that
# rationale went with it. MEASURED 2026-09-06: RSS is 111MB on the busy primary with
# two live rooms. 512 is still 4.6x that, and 256 stays off the table because V8
# wants headroom over the live set, not a ceiling on it.
SATELLITE_MEMORY=512

echo "==> fly deploy ($APP)"
# NOTE: do NOT let a non-zero deploy skip the re-shrink below. `fly deploy` exits
# non-zero on transient api.machines.dev flakes (health-check wait timeouts, cancelled
# requests) even when every machine actually updated — and with `set -e` that aborted
# the script mid-way, silently leaving the satellites on shared-cpu-4x. Observed
# 2026-07-20. So capture the status, ALWAYS re-shrink, and re-raise at the end.
deploy_rc=0
fly deploy --remote-only -a "$APP" "$@" || deploy_rc=$?
[ "$deploy_rc" -ne 0 ] && echo "!! fly deploy exited $deploy_rc — re-applying VM sizes anyway, then failing"

echo "==> re-applying per-region VM sizes (satellites -> $SATELLITE_SIZE/${SATELLITE_MEMORY}MB)"
ids=$(fly machine list -a "$APP" --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = new Set(process.argv.slice(1));
  for (const m of data) if (want.has(m.region)) console.log(`${m.region} ${m.id}`);
' "${SATELLITES[@]}")

while read -r region id; do
  [ -z "$id" ] && continue
  fly machine update "$id" --vm-size "$SATELLITE_SIZE" --vm-memory "$SATELLITE_MEMORY" -a "$APP" -y >/dev/null
  echo "   $region ($id) -> $SATELLITE_SIZE/${SATELLITE_MEMORY}MB"
done <<< "$ids"

if [ "$deploy_rc" -ne 0 ]; then
  echo "!! VM sizes re-applied, but 'fly deploy' had exited $deploy_rc — CHECK THE DEPLOY."
  echo "   Often a transient API flake with the rollout actually complete; confirm every"
  echo "   machine shares one IMAGE and is 1/1: fly machine list -a $APP"
  exit "$deploy_rc"
fi

echo "==> done. verify: fly machine list -a $APP"
