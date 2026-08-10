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
#
# ALPHA: `./scripts/fly-deploy.sh --alpha` deploys the PREVIEW app from fly.alpha.toml
# instead — one region, its own database, and no satellites to re-shrink. The two are kept
# in one script on purpose: a second script is a second thing to forget to update, and the
# only real difference is which config file and which app name.
set -euo pipefail

ALPHA=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --alpha) ALPHA=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

if [ "$ALPHA" -eq 1 ]; then
  APP="${FLY_ALPHA_APP:-dohun-sim-decode-alpha}"
  CONFIG=fly.alpha.toml
  echo "==> ALPHA preview deploy ($APP) — production is untouched"
  # -c pins the config: without it `fly deploy` reads fly.toml and would deploy PRODUCTION
  # under an alpha app name, quietly giving the preview production's multi-region VM block.
  deploy_rc=0
  fly deploy --remote-only -c "$CONFIG" -a "$APP" "$@" || deploy_rc=$?
  if [ "$deploy_rc" -ne 0 ]; then
    echo "!! fly deploy exited $deploy_rc — CHECK THE DEPLOY (fly machine list -a $APP)"
    exit "$deploy_rc"
  fi
  # no satellites here: the preview is single-region, so there is nothing to re-shrink
  echo "==> done. verify: fly machine list -a $APP"
  echo "    health: curl https://$APP.fly.dev/health"
  exit 0
fi

APP="${FLY_APP:-dohun-sim-decode}"
# EVERY region except the always-warm primary (iad) runs the cheap shared size.
# sjc joined this list 2026-07-20 (cost pass): US West is redundant with iad for
# the ~75% of games that are solo record runs, and it auto-stops when idle anyway.
SATELLITES=(sjc lhr syd nrt)
SATELLITE_SIZE=shared-cpu-1x
SATELLITE_MEMORY=1024 # MB — shared-cpu-1x defaults to 256MB, too tight for Node+tsx+Rapier

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
