# HANDOFF — 2026-08-15 (the classifier: possession, the gate, and the ramp) — alpha only

Branch **alpha**, commit `d3442fb`, **105 commits ahead of `origin/main`**.
`npm test` ALL PASS (~215 checks) · `npm run build` green · working tree clean.
**Not deployed.** Production `dohun-sim-decode` is still on the pre-session build and
still owes the migrations listed under "Still pending".

Do not merge to main. Standing rule.

## Where the session ended

The last three fixes are all in the DECODE classifier, and the last one closes the loop
the user opened with *"make a FUNDAMENTAL change and make it correct FUNDAMENTALLY."*

### The ramp is now ONE physics (`20b97a1`)

`OVERFLOW_FLOW_SPEED` is gone. It handed overflow artifacts a fixed 16 in/s down a
separate code path, which is why they crawled and why an opening gate could not reach
them. Every artifact on the ramp now runs the same solver — gravity `RAIL_ACCEL`,
contact stacking, one queue — and `overflow` means only two things:

1. the scoring flag, still decided at first contact (unchanged), and
2. **height**. An artifact is `elevated` while anything retained sits below it. That
   costs it `OVERFLOW_DRAG` rolling resistance (terminal ride ≈ `RAIL_ACCEL /
   OVERFLOW_DRAG`, ~36 in/s against the clear ramp's 46) and exempts it from the gate.

It sinks the moment there is nothing left to ride on — so an opening gate drains the
column out from under it and it simply follows, at ramp speed, on the ramp. Nothing
about it was ever special except its height.

**The trap, which cost most of a session.** The rail solver has TWO constraints and they
are not the same kind of thing:

- the artifact **AHEAD** — unconditional, artifacts cannot pass through each other;
- the **BASE** (the gate, or an occupied mouth) — a floor only for artifacts *above* it.

Conflating them broke this twice. Both unconditional, and a base that MOVES (`canLeave`
flips as a robot turns near the mouth) dragged the whole column back UP the ramp in time
with the steering. Both gated on "was it above this last tick", and an artifact dipping a
hair below its neighbour free-fell through the entire column and out through a shut gate
(measured: id 906 passing s=2.5 at 46 in/s with its floor at 7.1). **That second failure
survived a full session of a green suite** — smoke never checked that a closed gate
retains anything. It does now: three checks that nine artifacts stay put for five
seconds, packed at exactly `RAIL_PITCH` against the gate, scoring nothing.

### The exit: where the ramp ends, and nothing more (`c65209a`, `d3442fb`)

An artifact leaving the ramp used to be handed a flat floor velocity on the tick it
crossed the exit, on a fan 10–29° off the wall — nine of them left on the same diagonal
at 46 in/s and ran out across the floor. That was *"hyper accelerated and all going
diagonally in one direction"*.

**Two attempts at the drop are recorded here because both are instructive.** The manual
puts the gate's contact area 3.75–5.5 in up (9.8.3), so releasing it as a `flight`
artifact off a lip is the honest geometry — and it is wrong at 1:1. 3.75 in of fall plus
the bounces is **0.32 s of every artifact hanging in the air on the way out**, which does
not read as a ramp discharging; it reads as artifacts floating out of the wall. Charging
the drop's cost up front instead (multiply the horizontal by what a bounce keeps) puts
them on the floor but costs them **16 in/s on the tick they arrive** — precisely the
sudden step at ground contact that the release was rebuilt to remove, and there is a
smoke check for it.

So neither. The artifact lands immediately and keeps the speed the ramp gave it;
`BALL_ROLL_FRICTION` takes it out over the tunnel. Worst transition step is now
**1.33 in/s, exactly one tick of gravity**. The exit is not an event that does something
to the artifact — it is just where the ramp ends. `TUNNEL_EXIT_VEL.inward` stays at 4
(5–15°, down from 8) and the spread comes from artifacts caroming off whichever stopped
first. Measured over a full drain: within the **wall corridor** — gate, tunnel, or
loading zone — and 3–18 in off a 6.1 in tunnel.

`GATE_LIP_Z` is gone with the lip. If it comes back, note that `flight` requires a
`target`, which is meaningless for something falling off a ramp; it is read only by
`checkGoalEntry`, which also needs an UPWARD crossing of `GOAL_OPENING_Z` within
`GOAL_OPENING_RADIUS`, so an exiting artifact cannot re-enter.

### A robot's BODY is where the column stops (`d3442fb`)

Reported as *"balls can STILL pass through the robot when the robot is slightly blocking
the classifier"*, and it was one cause with the floating: **the classifier knew about
robots through a single point.** `exitMouth` tested `railPos(a, RAIL_EXIT_S)` and returned
a boolean, so a robot parked on the outflow stopped the flow while the column's floor
stayed at that fixed point — 7.3 in of artifacts sitting INSIDE the chassis, 1182 frames
of it. A robot 9 in to the side, touching nothing, blocked the whole ramp for the same
reason.

`railBlock` walks the rail line and returns the `s` a robot's body actually reaches; that
is the column's floor, for the elevated lane too (overflow rides over the retained column,
not over a robot). A robot WITH hopper room still collects the drain, now at its own
bumper — handing it over at `RAIL_EXIT_S` made the artifact travel the length of the
robot's footprint to get there, through the chassis.

Two things about that walk cost real time and should not be re-derived:

- **Its ceiling comes from the ROBOT's collision extents, not from the channel.** Bounding
  it at the classifier's gate end (s = 1) looks reasonable and is badly wrong: a robot on
  the mouth reaches s = 6.5, so the walk began already inside the chassis, stopped there,
  and put the floor 5 in inside the robot.
- **The floor is the sample the walk PROVED clear**, not the deepest blocked sample plus a
  radius — a radius along the rail is not a radius along the surface normal of a robot
  sitting at an angle, and that version still left 0.75 in of overlap.

Measured across five coverages from dead-centre to clear: **0.00 in, every one.**

### Earlier in the session

- **G408 over-possession** rebuilt on the manual's actual POSSESSION test (position in
  the robot frame, transitive chain from confirmed seeds) plus the real card model —
  MINOR **5** / MAJOR **15**, yellow at simultaneous 5 or three instances of 4+. The rule
  had been fouling the wrong robot and was switched off by a threshold set below its own
  signal.
- **The classifier ends AT the gate** — the rect used to run three inches past it and was
  drawn as a wall on the short end. Stroked on three sides now.
- **The mouth is a PLACE** — artifacts stop teleporting into a parked robot, and the
  doorway nudge sets a FLOOR on outward speed rather than adding every tick (it compounded
  to 91 in/s).
- **Chain Reaction**: flywheel launcher straddling the turret feed hole, beams apply yaw
  torque, mobile THROW button (hidden when the assist owns the action).

## Gotchas earned here

- **`npm test` passing is not evidence for anything it does not check.** Two of this
  session's three worst bugs were invisible to a green suite. Every behaviour the user
  reports twice now has a check; keep that up.
- **Probe, then change.** Several reports were refuted by measurement rather than fixed:
  the flick-shuttle carried 18 in for zero fouls where a shove carried 9 for three; chassis
  penetration by an artifact measured 0.00 in over 0 frames.
- The human player **restocks during teleop**, so any probe that measures "where the balls
  ended up" must filter to the ids it spawned. An earlier "max 148 in" reading was three
  loading-zone restocks, not drain artifacts.
- `Math.hypot` is banned in sim source by the smoke guard — use `hyp` from `src/math`.
  `Math.max/min/sign/PI` are fine.

## Open, not started

- **Ball/robot pass-through** — the classifier case is fixed and watched (`d3442fb`).
  The earlier "2.77 in penetration" reading was the intake mouth, which `ballRobotContact`
  leaves open *by design*; chassis penetration measures 0.00 in. If it is reported again,
  get the specific scenario rather than re-measuring the mouth.
- **Penalty hitbox audit** (roadmap #1) — the rules are right, the trigger volumes have
  never been checked against the manual figures.
- **Production deploy**: prod is on migration 0024; 0025–0029 plus the 08-07 spectating
  batch are pending. `./scripts/fly-deploy.sh` — **never a bare `flyctl deploy`**.
- Red cards are unreachable (G408 is the only card source and cannot issue a second
  yellow).
- "Replays for tank drive dont seem to be working" — `eb45f01` fixed recording; unverified
  end to end.
- `CLASSIFIER_W` 6 in vs `TUNNEL_W` 6.125 in — ⅛ in mismatch, noted, not changed.
- **At the alpha→main merge**: start a new Chain Reaction season from the admin menu.
  DECODE does NOT roll. Do not bump `BALANCE_VERSION`.
