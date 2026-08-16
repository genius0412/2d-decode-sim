# HANDOFF — 2026-08-15 (the classifier: possession, the gate, and the ramp) — alpha only

Branch **alpha**, commit `94e08ae` + UNCOMMITTED gate-cadence work (see "Drain cadence, part 2").
`npm test` ALL PASS (~237 checks) · `npm run build` green · **working tree DIRTY** — the
gate-cadence work is unstaged, awaiting review.
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

### The rail is not a hole in the field (`3eb8521`)

*"They still often go past the field wall then teleport back in."* They did. The state
column is the whole diagnosis:

```
tick 223  rail    pos 69.0 -71.0     already past the wall (field half is 72)
tick 228  rail    pos 69.0 -74.8     still marching, still on the rail
tick 229  ground  pos 69.0 -75.6     released six inches outside the field
tick 230  ground  pos 64.9 -69.5     ground clamp snaps it back: a 394 in/s teleport
```

The rail is a scripted 1D flow with **no wall awareness** — the rail line simply runs on
past the audience wall — so nothing about being off the field stops an artifact. It got
there because the solver and the release disagreed about whether it could leave: an open
gate dropped the floor to `-Infinity` while the release refused on an occupied doorway,
and the `wasS >= base` exemption then freed it permanently. `mouthClear` decides that
once now, doorway included, for both; the release lets **one** artifact out per tick,
since the one it just released is the next doorway.

**The exemption was too broad**, and this is the part to remember. It exists for exactly
one case: a shut GATE must not reach back up for an overflow artifact that legitimately
dropped in below the gate line. Two floors have no legitimate "already past it" — *below
the exit* (off the field) and *inside a robot* (7.2in inside the chassis, the very thing
the body floor was added to prevent). Those two are solid and unconditional. Correcting
them means moving an artifact UP, which the solver refuses on purpose, so it is
rate-limited to `RAIL_PUSH_RATE`: a robot leaning into the channel shoves the column up
its ramp visibly instead of teleporting it.

Sealing the exit made the queue rate **real**, and it was bad: `EXIT_NUDGE` 0.5 crept the
doorway artifact out at 11 in/s, 0.9 s to clear its own diameter, a nine-artifact drain
taking 12 s. That throttle was always there — it was hidden because artifacts queued
BELOW the exit, off the field, and burst out together once it cleared, which is what
*"disperse outward at insane speeds"* was. At 1.0 the queue moves at the speed of the
flow pushing it (the only non-arbitrary value) and the drain takes 8 s.

## Slice 2 (scoped): the chassis is in the ball solve — DONE (`8d184f6`)

An artifact squeezed between a bumper and the classifier used to be resolved by two
position writes taking turns — the bespoke robot push drove it in (3.13 in), the static
eviction shoved it back out (3.70 in), on an artifact whose velocity was **zero**.
Neither pass was wrong alone; they could not see each other. Reordering and interleaving
them each bought under 0.2 in, because **a squeeze is precisely a constraint with no
one-contact-at-a-time answer.**

The chassis is now a **kinematic** body in `solveBalls`, so bumper, channel wall and the
other artifacts resolve together. Kinematic also hands you product decision #7's
"gate outflow can't shove a parked robot" for free. The **intake stays bespoke** — its
mouth is open by design (#10) and its funnel geometry is per-preset.

Measured, robot grinding a pile into the classifier corner over 8 s:

| | baseline | after |
| --- | --- | --- |
| corner pile | 2.88 in worst, **41** jump-frames / 480 | 1.84 in, **4** |
| mid-wall | 4.50 in, 6 frames | 4.50 in, 6 frames |
| open field | 0.00 in, 0 | 0.00 in, 0 |

**Three earlier attempts failed and are worth not repeating.** Kinematic chassis with the
feedback still running *after* the solve: the stall never fires, and a dead-centre
artifact squirts 34 in along the wall with the robot sailing through at 30 in/s. Heavy
**dynamic** chassis, reading back the velocity delta so the stall is emergent: it is not
— an artifact is ~0.3 lb against 20–42 lb and the drivetrain restores the loss the same
tick. Feedback moved before the solve but probing the pin at a **full radius**: nine
checks broke at once (intake capture, gate drain, G417/G418 counts, clump stacking),
because a radius-wide probe calls anything within 2.5 in of a wall pinned and robots stop
driving into things at all.

What made it work:

- `ballRobotFeedback` moves **nothing** — only `r.vel` — and runs **before** the solve. A
  kinematic body cannot be told it is blocked, so the robot has to be stopped before the
  solver ever sees the squeeze.
- It probes the pin against **this tick's push** (`approach·dt`), not a fixed distance:
  *can it move as far as I am about to push it?*
- **`clampBallPosToStatics` now includes the classifier channel.** Its absence is why the
  stall never fired there: the clamp knew only the perimeter walls and goal faces, so an
  artifact pressed on the channel was never seen as trapped. **Anything solid an artifact
  can be pinned against must be in that clamp, or the pin test cannot see it.**

### What is left

A rare spike at the channel **entrance** — 6 frames of 480, 4.50 in — on an artifact that
begins a tick already embedded in the channel, where there is no entry path to walk back
and the eviction falls through to pushing it out the nearest face by depth+radius. Not the
continuous jitter, which is gone. Fixing it properly means the artifact should never be
embedded at the start of a tick, i.e. finding what still places it there (it is not
`separateBalls` — disabling that changed nothing).

Still genuinely deferred: flight/basin/rail artifacts remain scripted, and the intake
funnel geometry is still bespoke. Porting the intake would mean re-expressing the capture
model, which assumes artifacts can occupy the chassis-front region a collider makes solid.

## G408: two things were counted that the robot does not control (`7470c0c`)

Reported as *"I get overpossession penalties when I am just intaking from a clump"* —
*"clump against a wall, specifically"*. Reproduced at **five MINOR fouls** for driving
into a wall clump with the intake running, while the hopper ended with a legal three.

- **What the FIELD holds, the robot does not control.** A pile jammed between a bumper
  and a wall goes nowhere, and the manual names the case: BULLDOZING is explicitly not
  control. Excluded when the field refuses the push — **transitively**, because a jam is
  (the front row touches the row that touches the wall), and from the **chain** as well as
  the seeds, since the chain clause asks for contact and nothing else.
- **An artifact being drawn in is not a fourth artifact.** `POSSESSION_LIMIT` and
  `HOPPER_CAPACITY` are the same 3, so a full robot cannot keep what is in its mouth —
  counting it charges the same limit twice. 173 of 272 confirmed frames in the reported
  scenario were artifacts queued in the mouth. Gated on the intake actually running; with
  it off, artifacts in the mouth are being scooped and still count.

5 MINORs → 0, hopper still filling, and every existing G408 check still passes.

### ...and then it never fired at all (uncommitted)

*"I never get overpossession pen anymore."* The mouth carve-out above is right in principle
and was written as a **REGION**: everything anywhere in front of the chassis, unbounded in
count, for as long as the intake button was held. Drivers hold that button essentially all
the time, so the rule stopped existing. Measured, identical drive into an identical
six-artifact pile on open floor:

| | intake OFF | intake ON |
| --- | --- | --- |
| full hopper, 6 artifacts | 7 MINORs | **0** |
| empty hopper, 9 artifacts | — | **0** |

The carve-out is about the artifact being **ACQUIRED**, and the reasoning that justifies it
("HOPPER_CAPACITY and POSSESSION_LIMIT are the same 3, so the slot already charges it")
justifies exactly as many artifacts as there are slots. So it is capped at
`HOPPER_CAPACITY − hopper.length`, nearest the chassis first (deterministic, id breaks
ties). A FULL robot with the intake spinning has room 0 and is excused nothing — which is
correct and is the clearest over-possession there is: it has nowhere to put any of it.

Now 7 / 5 respectively, wall-clump-with-intake still 0, and every earlier G408 check still
green. **That block ran green through the whole regression** because every G408 check either
had the intake off or put the clump on a wall; the distinguishing case — full hopper, open
floor, button held — is now checked both ways and asserted equal.

**A velocity test was tried FIRST and is wrong** — worth knowing, since it is the obvious
idea and the user suggested it. "Moves with the robot ⇒ controlled" gets both cases
backwards: a wall clump slips a median **3.5 in/s** against the robot while a **herded**
one slips **15.6**, because pressing a jammed pile stalls the robot (both near zero) while
a clump actually being pushed rolls and squirms the whole way. Artifact speed and distance
travelled separate them no better (open clump travels 43–68in, herding 49–66in).

## Drain cadence, part 1 (`dcaf1f5`)

*"The balls flow out at a weird slow cadence"* — 0.77 s between releases, mean-abs-dev
0.10 s. A metronome. Two halves: gravity over one `RAIL_PITCH` (~0.33 s, real) and the
doorway wait (~0.5 s). `EXIT_CLEARANCE` was 4.5 — nearly two diameters — swept honestly
but for bespoke ground artifacts, where releasing at one diameter left a 2.8 in overlap
spike. Re-swept now that artifacts are Rapier bodies: **worst clump overlap is 0.12 in at
4.5 / 2.0 / 1.0 / 0.0 alike.** At 1.0, releases are 0.60 s apart and a nine-artifact
column drains in 5.2 s instead of 6.3 s.

## Drain cadence, part 2: the paddle has weight (uncommitted)

*"When the gate is held open, there shouldn't be a cadence. When the gate is not held open
but was left open (e.g. tapped open), it would have a semi uniform cadence but it would
randomly stop if the momentum is not enough to keep the gate open."*

Measured before touching anything, and the reading is the whole diagnosis: **held open and
tapped open drained at 0.596 s and 0.598 s.** The same metronome either way. Whatever the
gate was doing, it was not the thing metering the flow — and it was not doing anything at
all, because a ball in the gateway simply FROZE `gatePos` wherever it happened to be,
which meant a tapped gate hovered at 1.0 (fully lifted, 77°) with artifacts rolling under
it touching nothing.

### What was actually metering it (`floorV`, seeded at zero)

Traced per tick, the cycle was entirely artificial and repeated exactly once per artifact:

```
0.533  front s=-3.87 v=-41.2   arriving at the exit at speed
0.550  front s=-4.00 v=  0.0   clamped — st.v = max(st.v, floorV) with floorV = 0
0.617  released                 speed = |v| = ZERO
0.617..0.950   doorway distance pinned at 0.02 in    it never moved
0.950  next artifact reaches the exit, EXIT_NUDGE creeps the dead one out at 22 in/s
```

`rampFloorV` starts at 0 for the frontmost artifact, and it is not resting on a wall — it
is resting on **another artifact that is rolling away down the tunnel at 30 in/s.** Zero
said otherwise, so every artifact after the first was stopped dead, released motionless,
became the obstruction for the next, and the column re-ran 0.33 s of gravity down one
`RAIL_PITCH` from rest, every single cycle. The floor now moves at the speed of whatever
is on it (`exitFloorV` = the doorway artifact's `vel.y`, and only while the gate is OPEN —
against a shut gate the floor is the paddle, which is going nowhere).

### The arm cannot hover (`GATE_RIDE_FRAC`)

Everything the user described falls out of one physical fact, with no special cases: an
unheld arm falls until it **lands on something**, and an artifact is a ball's worth of
lift and no more.

- **HELD** — a robot latches it at 1.0, clear of the flow. No contact, no drag, no cadence.
- **TAPPED** — the arm settles onto the stream at `GATE_RIDE_FRAC` and rides it. Its weight
  drags each artifact passing under (`GATE_PADDLE_DRAG`, scaled by `1 − gatePos`, which is
  why a held arm costs the flow exactly nothing), and it sags in the gaps, so the next one
  must shoulder it back up.
- **GIVES OUT** — the height an artifact can hold the paddle to is proportional to its
  speed (`GATE_SHOULDER_LIFT`). A column that has spread out can no longer lift it past
  `GATE_PASS_FRAC`, the arm settles, and the drain stops. Deterministic (no RNG — the sim
  cannot have any here) but scenario-dependent enough to feel like it just gave up.

Measured, nine-artifact column: **held 0.323 s mean / 0.073 mad, all 9 out in 3.0 s
(was 5.2 s); tapped 0.376 s / 0.144 mad, 8 of 9 out, arm riding at 0.449–0.62, then shut.**
A second tap clears the rest — it is a stall, never a deadlock, and there is a check for
that. Six new smoke checks cover the pair.

`gatewaySpeed` is deliberately a LOCAL in `updateGates`, not a `GoalState` field: goal
state rides the network snapshot, and a new numeric field is the exact shape of the
stale-server NaN bug in memory. It is recomputed from world state every tick anyway.

**`EXIT_CLEARANCE` was left at 1.0.** At 0.0 the held drain is smoother still (0.260 s /
0.048) — but the tapped drain then never gives out, and that is the behaviour being asked
for. It is a swept value from the previous session; do not churn it to buy cadence that
the paddle model should be providing.

### The arm rests ON an artifact, never between two (uncommitted)

*"When the classifier flow is stopped by the robot, the gate is always in between two
artifacts. This does not have to be that way."*

It was not a preference the arm had — it had **no idea what was underneath it.** With the
flow halted it fell straight to 0 THROUGH whatever sat in the gateway, measured at every
offset from +4 to −2.4 in: `0.000` every time. The ride model above was keyed on SPEED
alone, so a stopped artifact held it up not at all.

The paddle's edge descends the vertical at `GATE_LINE_S` (= `GATE_STOP_S − BALL_RADIUS`)
and lands where that meets the artifact's surface: height `R + sqrt(R² − d²)`. A full
diameter of clearance IS the pass height, so it maps onto `GATE_PASS_FRAC` with no constant
of its own — dead on top is exactly the pass line, the equator is half of it, and past the
artifact's edge the paddle misses entirely (which is why a column packed at `GATE_STOP_S`,
one radius clear, still reads as fully shut — that existing check was the load-bearing one).

**Which side it landed on is the whole outcome**, and measured it comes out clean:

| d (centre − gate line) | arm rests at | once the robot is gone |
| --- | --- | --- |
| +2.0 (not through) | 0.338 | wedged, stuck at s=1.31 |
| +1.2 | 0.383 | wedged, stuck at s=0.51 |
| −1.2 (mostly through) | — | **squeezed out**, arm shuts behind it |
| −2.0 | — | **squeezed out** |
| ±2.6 (beyond the edge) | 0.000 | paddle misses it |

`d > 0` is a wedge and needs its own clamp: the solver's gate floor sits at `GATE_STOP_S`
and an artifact the arm has landed ON is *below* it, hence exempted by `wasS >= base` — so
without it the thing rolled out from under a paddle resting on it. `d < 0` gets
`GATE_PADDLE_SHOVE`, the horizontal component of the paddle's weight, scaled by `d/R`. Only
the downhill half is applied; an up-ramp force would fight the solver's "never push it back
UP" invariant, and the block already does that job.

**The trap, which cost a red suite of fourteen unrelated checks.** `gateRestOn` returns 0
for *two different reasons* — "the arm is flat on the ramp" and "this artifact is nowhere
near the gate" — so `gatePos <= gateRestOn(d)` alone calls every artifact on the rail a
contact whenever the gate is shut. That froze the entire rail the instant the gate closed:
nothing reached the stack, nothing classified, and point-blank shots "stopped entering the
goal". The reach test (`|d| < R`) has to come first; `paddleBearsOn` exists so there is one
place that can be got wrong.

Also fixed a check that was measuring the wrong thing: comparing *mean gaps* between held
and tapped is a trap, because the tapped run gives out early so its mean covers only the
opening (fast) releases while the held mean is dragged up by the later ones, where a pile
has built outside the gate — it read as the tapped gate being FASTER. Do not restate the
claim that way.

### "The gate always empties all. I told you it shouldn't." (uncommitted)

It did, and the 9-stack check that "passed" was hiding it. Swept by column depth, a tap
drained **every column up to six artifacts** — and real ramps hold a handful, so in play it
always emptied. Two causes, and the second is the one that mattered:

**1. The tap latch pinned the arm at maximum lift for 0.5 s with nothing touching it.** A
hinged arm cannot do that. `GATE_OPEN_LATCH_S` is now the arm's mechanical OVERSWING (0.08 s)
and the arm is pinned only while a robot is genuinely on it; "stays open a beat" comes from
the FALL instead — ~0.23 s from full lift to the pass line, artifacts flowing the whole way.
Touch-hold is untouched and is what legitimately pins it. **This changes a documented product
decision** (CLAUDE.md updated): a tap still commits the arm fully open and you still do not
have to keep pressing.

**2. `GATE_SEAT_FRAC` — seated under the arm is NOT past it.** The geometry originally mapped
"paddle resting dead on top of an artifact" to *exactly* `GATE_PASS_FRAC`, on the reasoning
that a full diameter of clearance is the pass height. That is off by precisely the amount
that matters: resting on top is the MARGINAL contact — clearance is the ball and no more —
so with the arm's weight on it, it does not roll through. And because the gateway window
(8.5 in) is wider than the artifact pitch (5.1 in), a packed column ALWAYS has something
under the arm — so if being under it holds the gate exactly passable, a dense column keeps
itself flowing forever, which is what it did.

Seat is now 0.34 against a pass of 0.4, and getting past takes momentum:
`GATE_SHOULDER_LIFT` 0.045 → **0.016**, putting the threshold at ~25 in/s, inside the 20–46
in/s band the ramp actually produces. At 0.045 the threshold was 8.9 in/s — below anything
on the ramp, so every artifact cleared it and the rule never bit.

**`GATE_RIDE_FRAC` swept 0.44 → 0.62 changed nothing**, which is what pointed at the seat
height rather than the ride height. Don't re-sweep it.

Measured now: **hold drains 9/9; one tap drains 3 and gives out at every depth 5–9**, and
what a tap is worth varies with packing (3/3/2/2 at +0/1.5/3/5 in extra spacing) rather than
being a fixed dose. Both are checked, the depth sweep explicitly — a 9-stack stalling proves
nothing on its own.

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
