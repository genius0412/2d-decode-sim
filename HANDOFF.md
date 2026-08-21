# HANDOFF — 2026-08-18 (the ramp: a stalled column, and the overflow lane) — alpha only

Branch **alpha**, commit `907a90f`. Working tree **CLEAN**. `npm test` ALL PASS ·
`npm run build` green · `npm run server:check` green. **Not deployed** — production
`dohun-sim-decode` is still on an older build and still owes the migrations listed
further down.

Do not merge to main. Standing rule.

## Where this session ended

Fourteen reports: the DECODE classifier ramp and gate, the intake at its outflow and in a corner, and one Chain Reaction terrain bug. The first two trace to the same kind of
thing:
a constant (or the absence of one) that was correct against the OLD `RAIL_ACCEL` of 80 and
was not rescaled when the ramp became 25 and lost its capped flow speed (`57a308e`).

### A stalled column no longer winds up (`a653810`)

*"after ball flow resumes after being stalled, it shoots down extremely quickly"* — a
blocked artifact went on accumulating `RAIL_ACCEL` into `v` every tick it stood still. The
only cap on a blocked artifact's speed was the floor's, and an OPEN gate declares "no cap"
(`exitFloorV = -Infinity`), so an open-but-blocked drain — a robot parked on the outflow,
or the doorway busy — pinned the column in place while `v` marched -5, -10, -15 … to the
`RAIL_TERMINAL` **safety** cap of 120 in/s in 4.8 s. The instant the block cleared they left
at up to **86 in/s** and the whole ramp emptied in one burst.

The fix is one line: `wasV` — the artifact's speed BEFORE this tick's gravity — is a cap in
its own right alongside the floor's, so `st.v = Math.max(st.v, floorV, wasV)`. Whatever
holds an artifact up pushes back exactly as hard as gravity pulls, so being held is never an
acceleration; it still keeps the momentum it ARRIVED with, which is what the exit lip has
always done. A FLOWING drain is untouched — an artifact in a moving column is in contact for
a tick at a time, because the one ahead has more runway and opens the gap itself.

**Capping at the DOORWAY artifact's speed was tried first and is a different bug**: that
queue is nudged along at ~22 in/s, so the whole ramp is throttled to it — mean release gap
0.58 s against 0.32 s, and a held gate stopped emptying the ramp. The note in `updateRails`
records it so it is not re-attempted.

### The overflow lane flows again (`1f95735`)

*"ball flow for overflow is weird and slightly slow"* — it was both, from two constants:

- **`OVERFLOW_DRAG` → `OVERFLOW_ROLL_LOSS`.** A 2.2/s velocity drag pins the ride at a
  terminal of `RAIL_ACCEL / 2.2`: 36 in/s under the old ramp, **11 in/s** under this one,
  against a ramp lane running 17..54. It is now a CONSTANT deceleration (9 in/s²) for the
  same reason `RAIL_ACCEL`'s own note gives — rolling resistance does not grow with speed,
  so there is no terminal and speed is a consequence of distance travelled. Both lanes are
  one physics again and the ratio is readable: `sqrt((RAIL_ACCEL − loss) / RAIL_ACCEL)` = 0.8.
- **`OVERFLOW_BUMP` 40 → 12.** At 40 the scallop was 1.6× the pull meant to drive the ride,
  which stops being a texture and becomes a TRAP: four riders dropped onto a full column,
  three stuck on it forever (one held at **v = +5 in/s**, pushed steadily back UP the ramp)
  and the fourth creeping out at 16 in/s after four seconds. The invariant is arithmetic —
  `RAIL_ACCEL − OVERFLOW_ROLL_LOSS − OVERFLOW_BUMP × OVERFLOW_SLOPE_MAX > 0` — and swept
  over 26 starting states the strandings begin the tick it goes negative (bump 19). At 12
  the ride gains speed at 4..28 in/s² and every rider comes off: exits 18..29 in/s in
  1.4..2.9 s.

**A bump strong enough to make the rider DECELERATE on a crest is strong enough to strand
it** on the uphill shoulder of the topmost artifact, where nothing above can push it back
on. The old "loses speed cresting each artifact" check was passing off the velocity drag,
not the geometry; it now asserts the SWING in the rate of gain, plus the invariant itself.

### Checks added

- `a column held against a block does not accumulate speed while it waits` (2 s vs 6 s into
  a stall, no growth) and `...and it resumes at ramp speed rather than shooting out of the
  gate` (under the ramp's own `sqrt(2as)` ceiling).
- `every overflow artifact clambers off the column instead of parking on it` (9 starting
  heights) and `...and leaves the ramp slower than the ramp lane but far above the old drag
  crawl`.
- The `LURCHES` + invariant pair replacing the old crest-deceleration check.
- The ramp-height check is sampled PER ARTIFACT now: its half-inch `s` buckets spanned two
  inches of `z`, and a column that comes to REST part way out of the mouth (which it now
  legitimately does) made the aliasing visible.

### The exit goes straight down (`fb286db`)

*"All the balls keep coming out of the gate at the same angle."* The release leaned every
artifact 5-15 degrees off the wall, and the jitter varied the lean's MAGNITUDE and never
its SIGN — so the whole drain left on the same diagonal. A wider or narrower fan only
changes how wide that one diagonal is, so the fan is gone rather than retuned.

The channel runs down the wall and the artifact rolls off the END of it, so it leaves in
the direction it was already going. The only sideways motion it has a claim to is the
weave it was doing across the groove, and `railWanderRate` (new, in field.ts) is exactly
that — how far the groove carries it per inch travelled, so times its own speed it IS
that artifact's lateral velocity. Signed, a couple of in/s, different per artifact.
Measured over a nine-artifact drain: **2.5, -3.0, 1.7, 0.5, -2.4, 3.0, -1.9, -0.2, 2.2
degrees**. `TUNNEL_EXIT_VEL` keeps only its speed (the doorway nudge's).

### A ball coming out lifts the arm, and pays for it (`7d4239d`)

*"A tap only lets out one ball now… a ball coming out is not lifting the gate back up."*
Two things, and the second is the interesting one.

- **The knock was gated on `GATE_PASS_FRAC`**, which is where an artifact gets THROUGH, not
  where it can reach the paddle from underneath. An arm a hair below the pass line was a
  wall. The threshold is now `gateRestOn` at the moment of contact — the height the paddle
  sits at when resting on that artifact's surface. A FLAT arm is still a wall at any speed,
  so retention is untouched.
- **The knock was FREE.** The arm was thrown up at no cost to the artifact, so a knock hard
  enough to reopen a sagging arm was also one that could never run out — the yield was a
  cliff (one artifact, or all nine, decided by a fifth of a second on the lever). A
  collision moves momentum; it does not mint it. **`GATE_STRIKE_LOSS` (new, 0.45)** charges
  the lift to the striker, so the arm's weight is what the flow spends itself against and a
  drain gives out when the column can no longer pay. A LATCHED arm is touching nothing, so
  holding it still costs the flow nothing.

`GATE_KNOCK` 0.06 → 0.12 with that loss. Packed nine-column, tap length → drained:
**0.10s 2 · 0.12s 2 · 0.15s 2 · 0.18s 2 · 0.20s 3 · 0.25s 7 · 0.30s 8 · 0.40s 9**, against
1/1/1/2/2/2/4/9 before. The 27-condition sweep spans every value 1..9.

**The knock-scaling check was measuring two speeds that both saturate the arm** from
`GATE_RIDE_FRAC` and reported 1.00 twice. It now measures from a SAGGING arm, which is
where a drain is actually decided: from 0.31, 5 in/s reaches 0.35 and stays shut, 10 in/s
reaches 0.46 and reopens it, 18 in/s reaches 0.75.

**A note for the next tuning pass.** `RAIL_ACCEL` 80 → 25 (`57a308e`) doubled the time a
resting column needs to deliver its next artifact — `sqrt(2·RAIL_PITCH/a)` went 0.36s →
0.64s — while the arm's fall from full lift to the pass line stayed at 0.45s
(`GATE_GRAVITY` 6). That race is why short taps went bimodal in the first place. The
strike now bridges it; if it ever needs revisiting, `GATE_GRAVITY` is the constant that
was never re-derived against the ramp it meters.

### The arm's fall is set against the ramp it meters (`d963c05`)

*"A tap lets out 1 or 2"* — still, after the strike fix, and this is the structural half.
A tap on a RESTING column is a race between two times:

| | |
|---|---|
| the arm's fall from fully open to the pass line | `sqrt(2·(1−GATE_PASS_FRAC)/GATE_GRAVITY)` |
| the column's delivery of its next artifact | `sqrt(2·RAIL_PITCH/RAIL_ACCEL)` |

The second **doubled** when the ramp stopped running at a capped flow speed (`RAIL_ACCEL`
80 → 25, `57a308e`): 0.36 s → 0.64 s. `GATE_GRAVITY` stayed at 6, a 0.45 s fall. The arm
was therefore always shut before the second artifact could arrive, and **no knock can fix
that** — the first gap is covered by nothing at all.

- **`GATE_GRAVITY` 6 → 4**: fall 0.55 s against the column's 0.64 s. Marginal is the point,
  and the ratio has a CEILING as well as a floor — at 2.9 the fall matches the delivery and
  the yield is 9 of 9 in **every one of 50** tap conditions, i.e. the drain can no longer
  give out at all.
- **`GATE_KNOCK` 0.12 → 0.07**: with the strike loss a flowing column sits at a fixed-point
  arrival speed (~19 in/s), so the rise per knock is a constant compared against a constant
  fall between arrivals. Set high, every drain that survives its first gap runs the whole
  ramp: at 0.12 the sweep was 9-or-nothing (12 ones, 36 nines, nothing between). At 0.07 it
  spans 1..9, mean 5.

Packed column, tap length → drained: **0.10s 2 · 0.15s 3 · 0.20s 5 · 0.25s 9**. Loosen the
column to +5in and a quick tap is worth 1 again, which is the situational answer it is
supposed to have. Checks: a 0.12 s bump is worth more than one artifact at three packings,
and the fall/pace RATIO itself, so the next `RAIL_ACCEL` change trips in the suite rather
than in a play session.

### Where the sim actually runs, which cost half a session

Worth stating because it looked like the fixes were not landing: **a record run is a server
room** (`RecordRun.tsx` joins a `LobbyClient` room with `kind: 'record'`), as are lobby,
matchmaking and ranked. In all of those the authoritative sim is the Fly app — `dsim-alpha`
for the alpha site — so classifier changes are invisible until that app is redeployed. Only
**Free Drive** (`session: null`) runs the client bundle's sim. `flyctl` on this box has no
usable token (`fly auth whoami` → "no access token available", both shells; `~/.fly/
config.yml` dates from 11 Jul), so a deploy needs `fly auth login` first, then
`./scripts/fly-deploy.sh --alpha` — never a bare `fly deploy`.

### Nothing on the ramp outruns the ramp (`519f69e`)

*"Sometimes balls come down the ramp extremely fast. Only sometimes. And way too fast."*

An artifact boarded the rail carrying whatever `vel.y` the BASIN had given it, and
`BASIN_FUNNEL_ACCEL` is 1150 in/s² — three times gravity, a scripted drain aid so the basin
does not clog, not a slope. Measured over six seeds of a firing robot: **boarding up to
52 in/s, peaking at 75 on the ramp, 12 of 18 over 60**, against a ramp whose own free-fall
ceiling over its whole length is 54. The *"sometimes"* was simply whether an artifact dived
straight at the entrance or jumbled in the basin first.

The channel entrance is a THROAT, not a launcher. Boarding is capped at what the ramp
itself could have produced by that point — `sqrt(2·RAIL_ACCEL·(RAIL_S_MAX − s))` — floored
at the new `RAIL_ENTRY_V` (8) so a dribbler still gets under way. After: boarding 8 flat,
peak 47..55, none over 60. **Throughput is unchanged** (18 scored either way, worst basin
backlog 3 either way), so the cap costs the drain nothing.

The invariant is now a check: *nothing on the ramp is faster than an artifact released at
the top of it.* That is the property that makes the flow legible, and it is worth keeping —
any future "the classifier feels wrong" report should be tested against it first.

### The intake has a roof (`ac774db`)

*"The intake should not intake if a ball drops on top of it."*

The mouth is open at BALL HEIGHT on purpose — that is what lets an artifact roll in under
the rollers, and it is why `ballRobotContact` returns no contact in the centre of the mouth
("the wheels ride high in z, so balls pass under them"). **That fact has an unstated other
half: what rides high in z is solid to anything coming DOWN.** Without it the mouth was open
from above as well, and an artifact dropped on the intake fell through the rollers into the
throat and was swallowed — 11 of 18 drops from 24in across the three presets.

`intakeLidZ` is the height the mouth geometry already implies: the roller's underside must
clear a full artifact for one to pass beneath it, so an artifact landing ON the roller sits
a diameter, plus the roller, plus its own radius up. `INTAKE_LID_THROW` sends it forward
along the robot's axis — a roller's axis runs ACROSS the robot, so forward or back is all
there is, and back is the chassis.

**The roof's BACK edge is load-bearing, not padding.** An artifact dropped on the CHASSIS is
ejected out of its nearest face by the contact code, and near the front that face is the
front — which puts it in the throat, a radius forward, still falling. Before the roof was
extended back a radius (to exactly `updateIntake`'s own capture window) every funnel preset
still swallowed a chassis-front drop. After: **0 of 18 taken, 18 of 18 on the floor forward
of the roller line**, where a running intake may then take them the way it is supposed to.

Note what was deliberately NOT done: the CHASSIS did not get a roof at `ROBOT_HEIGHT`. Shots
pass over robots today (nothing collides above `BALL_RADIUS*4`), and a chassis roof would
start intercepting them — which would break "the shooter never misses". A ball resting on
top of a robot also needs a state that does not exist.

### Parking on the outflow blocks it (`b37f3ba`)

*"Once I open the gate and then stand directly in front of where the balls come out, there
is no space for the balls to drop, so it would drop on top of the intake. However, it is
being intaked, still."*

The intake roof from `ac774db` did not cover this, because **the outflow does not FALL**: an
artifact leaving the ramp is LOWERED from ramp height to the floor over the last couple of
inches of rail and then released as a ground artifact. With a robot parked on the drop point
that lowering ran straight through its intake and set the artifact down INSIDE the mouth, at
floor level — the one place it could not have reached on its own.

`railBlock`'s chassis test is deliberately not the footprint (a robot holding the gate open
must not read as blocking the drain it is opening). But *"the mouth is open at ball height"*
only answers for an artifact that IS at ball height, and the outflow is not — the ramp
discharges at `RAMP_SURFACE_Z` ≈ where an intake's roof sits. So **the roof blocks the column
exactly as the chassis does**. It is a far tighter region than the footprint (the mouth, not
the whole front), and the rail line runs 3in from the wall while the gate arm is at the
classifier EDGE, so a robot working the lever is never over it.

Parked on the drop point: **0 taken, 9 left on the ramp** (3 taken before). Backed off three
inches: 3 taken — that is gate intaking and it must keep working; both are checks now.

**Releasing onto the roof instead was tried and is worse** — it makes a flight artifact at
ramp height carrying the roller's throw speed, and a flight artifact is exactly what can sail
through a gap it does not fit through. The existing gap check caught it. Noted so it is not
re-attempted.

One condition of the nine-way tap sweep moves with this: at the closest standoff the robot's
own intake covers the outflow, so it holds its own drain shut for the length of the tap
(9 → 3). That is the rule working, and the check says so rather than being tuned around.

### The paddle is a stick resting on a sphere (`fb562e1`)

*"The amount and the point at which the gate opens when a ball forces it open is very off.
Remember that the gate is a stick that is riding on top of a sphere."*

It was modelled as a **plunger** — the paddle's edge coming straight down the vertical at the
gate line, reading the artifact's surface height there (`R + sqrt(R² − d²)`) and mapping it
linearly onto a free constant. The paddle is hinged off to one side of the channel, so it
meets the artifact at a **tangent**, and a tangent's angle is both larger and a different
shape. `gateRestAngle` (config.ts) is the algebra:

    hypot(xb, W) · cos(t + atan2(W, xb)) = sqrt(xb² + d² + W² − R²),   W = GATE_PIVOT_Z − R

**The hinge height is the only free number, and the MANUAL picks it.** 9.8.3 puts the gate's
contact area 3.75–5.5in above the ramp, which is exactly where this stick touches this
sphere; the height that lands the apex contact mid-band is **3.5in**. A ramp-level hinge
contacts at 2.95in — below the band — which is what rules out the reading where a 5in
artifact stands a 6in stick almost vertical (that reading gives an apex rest of 1.03).

| d from the gate line | 0 | 1 | 2 | 2.29 |
|---|---|---|---|---|
| plunger (was) | 0.340 | 0.326 | 0.272 | 0.238 |
| tangency (now) | **0.437** | 0.362 | 0.128 | 0.000 |

The reach is no longer the artifact's radius: the tangency answers **2.29in**, and
`GATE_LINE_S` is now DERIVED from it so a column still rests packed at `GATE_STOP_S` exactly
as before.

**`GATE_SEAT_FRAC` and `GATE_PASS_FRAC` are now one derived value.** The 0.34/0.40 gap was a
fudge doing a job — "seated under the arm is not past it" — and it was needed because the old
gateway window was 8.5in against a 5.1in artifact pitch, so something was ALWAYS under the
arm. The stick's own window is 4.58in, less than one pitch, so the geometry does that job:
the stick rides highest at the apex, and clearing the apex IS passing.

Behaviour holds — a shut gate retains at every arrival speed 10..60 in/s (stopping at exactly
`GATE_STOP_S`), and the tap sweep still spans 1..9, mean 5.8.

**Still scripted, and the next thing to look at if this is revisited:** an artifact does not
yet WEDGE the arm up along the tangency as it advances (the arm's rise is still the
`GATE_KNOCK` impulse). The geometric version is `rest'(d) · v`, needs no constant at all, and
would make "a ball forces it open" a kinematic consequence — but it also needs the paddle's
FACE modelled (below the artifact's equator the edge blocks rather than wedges), or a fast
artifact levers a shut gate open.

### Pressing the lever is not parking on the outflow (`f82044a`)

*"I only get one or two balls from a tap way too often."* It was worse than that: a driver
who bumped the gate and **stayed** — which is what a driver does — got **nothing**. Measured
across five tap lengths pressed in close: **0 of 9 every time**, against 2/3/9/9/9 for the
same taps if the robot backed away.

The cause was the outflow block from `b37f3ba`. Its region carried a radius of slop around
the mouth, and at the gate that radius is exactly the difference between a robot whose MOUTH
is over the drain and one merely pressing the lever with the TIP of its intake — the chassis
front sits at the classifier edge, the intake reaches the rail line, and the padded roof then
covered the drop point. The standard technique read as parking on your own outflow.

The padding is right for LANDING (an artifact perched on the lip really does overlap the
roof) and wrong for asking whether the roof is in the way of something else, so
`intakeRoofAt` takes it as a parameter and the rail block passes **zero**. Parking the mouth
ON the drop point still blocks (0 taken, 9 left); pressing the lever no longer does (9 at
every tap length). Both are checks.

Also added: **above the mouth's opening the intake is not open.** `ballRobotContact` leaves
the mouth's centre clear because the rollers ride high and artifacts pass UNDER them — true
only of an artifact at ball height. One riding the ROOF is above the opening, where the
structure is solid; `ballRobotFrontContact` is that case. It matters because a roof-riding
artifact is in FLIGHT, and flight artifacts are not in the ground solve.

**Do not "release onto the roof" instead of blocking up-ramp.** Tried twice this session. It
makes a flight artifact beside a robot, and one drifted through a 4.6in gap between a robot's
corner and the wall — which is a bug report of its own, with a check. The note is in the
release code.

### The ramp is a 10-degree chute now, and 5-9 per tap is a BENCHMARK (`5fa9c18`)

*"I feel like the initial balls are too slow (or perhaps all of them, in general)."* They
were, and the first one worst of all: `RAIL_ACCEL` 25 is a **5.2-degree** ramp, so a column
starting from rest took **0.70s** to put its first artifact out, at 18 in/s. That value was
set when the ramp stopped running at a capped flow speed — the cap used to hide the slow
start.

`RAIL_ACCEL` **50** is a 10.5-degree chute, the sort of slope you would build for a gravity
feed that has to start a stationary ball reliably. First artifact out at **0.48s at 24 in/s**,
all nine clear in **1.65s** (was 2.37s), arrival gaps 0.25 → 0.10s.

**Three constants that were sized against the old ramp are now DERIVED from it**, so the next
slope change carries them instead of silently breaking the balance:

| | |
|---|---|
| `OVERFLOW_ROLL_LOSS` | `0.36 · RAIL_ACCEL` — the ride keeps its 0.8 speed ratio |
| `OVERFLOW_BUMP` | `0.48 · RAIL_ACCEL` — the scallop stays under the net pull |
| `GATE_GRAVITY` | `(1 − PASS) · RAIL_ACCEL / (0.74 · RAIL_PITCH)` |

That last one is the fall-to-pass vs one-pitch-from-rest relation the suite already checks,
solved for gravity: the ratio stays **0.86 at any slope**, which is what keeps a tap worth
something.

**THE BENCHMARK — "on a gate tap, 5 to 9 balls must release" — is a check now**, over 30 taps
(three packings × five tap lengths × two standoffs): worst 6, best 9, mean 8.8. `GATE_KNOCK`
0.06 → **0.05** is what puts the spread inside the band rather than pinned at 9; at 0.04 the
worst case falls to 4 and it fails. **Do not tune the gate without re-running it.**

The packing-variety check it replaces asked the yield to depend on how tightly the column was
packed — true on a 5-degree ramp where the flow was marginal enough for spacing to decide
whether it sustained. At 10.5 degrees a firm tap carries any column (loosening the pitch by
8in changes nothing) and what varies is the tap.

### Three from one session's play (`0ae0db6`, `1f8b612`, `907a90f`)

**A funnel intake collects a corner artifact** (`0ae0db6`). A wedge preset only swallows at
the THROAT and the suction walks the artifact there — which works in open field and cannot
work in a corner. An artifact tucked against two walls sits 2.5in off each, and what decides
how close the robot can get is its own chassis half-width (9in), so it ends up ~6.5in off the
mouth's centre: outside a 3in throat, unmovable. Putting the throat on it means putting the
chassis through a wall. A real funnel pressed into a corner does collect it, so a wedge now
takes an artifact inside its MOUTH (not merely its throat) that is pinned against the field
boundary, at the slow end of the timing. `INTAKE_WALL_GRAB` is deliberately tiny — this is
"against the wall", not "near the wall". Measured in the audience corner: sloped 0.35s /
triangle 0.30s along the wall, 1.18s / 2.87s on the diagonal. Vector is unchanged (its wheels
already span the mouth; its answer to an off-centre artifact is the flank grab).

**An artifact needs ground to drop onto** (`1f8b612`). The outflow block tested the mouth
UNPADDED, so an artifact only needed its CENTRE outside the intake — it could be set down half
inside one and taken. The rule is about the artifact's own footprint: the drop point needs a
full RADIUS of clearance, exactly as it already needs from a chassis. The lenience is the
front of the rollers and nowhere else (`INTAKE_CATCH_LENIENCE`, "if the ball drops on the very
front edge of the intake rollers, they can suck them in due to compliance"). Swept by tip-to-
drop-point distance it is a clean step: **1.0in clear → 0 taken, 9 left on the ramp; 1.5in
clear → they land and feed.** That front lenience is also what keeps a lever-pressing robot
from plugging its own drain.

**The beam curb no longer teleports** (`907a90f`). Measured, a mecanum driving diagonally over
a beam: **3.44in of position in ONE tick** against the 0.45in its velocity could account for;
8 of the swept crossings jumped, all mecanum (the only drivetrain with the strafe curb). Two
causes, both in `strafeCurb`/`beamStrafeBlock`:

- the straddle guard wanted a wheel a full WHEEL RADIUS past the far face (3in past centre).
  Mid-crossing `side` flips as the BODY passes the centre, the wheels behind become far-side
  wheels with a small negative `rel`, and the curb fired on a robot half way over and shoved
  it the rest of the way. **A wheel past the far face** is the honest test.
- the correction was unbounded, though its own note calls it a slop clamp. `CHAIN_BEAM_CURB_SLOP`
  caps it at **0.35in per tick**. Worst overshoot after: 0.16in, and the curb still parks the
  leading wheel exactly at the near face — over three ticks, which is what a clamp looks like.

## Next steps

1. Play-test the drain by hand — both fixes are measured headlessly, and the feel of a
   tapped gate against a packed column is the thing worth eyeballing.
2. The rest of the standing list below is unchanged.

---

# HANDOFF — 2026-08-15 (superseded) (the classifier: possession, the gate, and the ramp) — alpha only

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
