# HANDOFF — 2026-09-06h (a UI standard, an audit that enforces it, and the alpha UI swept)

Branch **alpha**. `npm test` ALL PASS · `npm run contrast` 221 · `npm run uiaudit` at
baseline · `npm run build` · `npm run server:check` green. `SIM_VERSION` untouched at **2**.
⚠️ An earlier commit in this run changed user-visible strings in `src/sim/` and
`src/games/chain/`, so the Fly server still needs a redeploy for the foul lines and the
event log to match the client.

## READ FIRST — `docs/ui-standard.md` and `npm run uiaudit`

The owner's verdict on the alpha UI was "a ton of spacing issues and overall consistency
and weird ai text description unnecessary things", followed by "create a very strict UI
design standard" and "consider other ways to make UI consistent and choose your path".

**The path chosen: tokens + a zero-dependency ratchet, not a document alone.** A standard
nobody greps is not a standard. `scripts/uiaudit.mjs` is the same shape as `contrast.mjs`
and `shiftaudit.cjs` — one command, no deps, deliberately OUT of `npm test` so a red test
still means physics broke. Every rule carries the count measured when it was written and
fails only when a count goes UP, so the standard bound new code immediately without a
big-bang refactor of the debt. Rejected: Stylelint (deps, and blind to both bugs below),
and shared `<Panel>`/`<Row>` primitives (right destination, but a 60-file refactor of a
shipping UI is not a spacing fix).

Every number in the standard is MEASURED. The codebase had **no spacing tokens at all**,
ten distinct `gap` values, eighteen font sizes (six fractional), seven weights, and 105
spacing literals inlined in JSX.

### The two rules that are hard errors, because both bugs shipped silently

- **UNDEFINED CUSTOM PROPERTY.** `--ds-font` was used 13 times and defined nowhere. In a
  `font:` shorthand an unresolvable `var()` is invalid at computed-value time and drops the
  WHOLE declaration, so `.ds-gauge-num`, `.ds-standing-name`, `.ds-report-h` and ten others
  set no weight, size or line-height for months, with nothing in the console. `--accent` was
  the same bug wearing a `#literal` fallback, which is why those are banned too.
- **DUPLICATE SELECTOR.** `.ds-dl` was declared twice for two unrelated components — the
  replay export menu and the download page — and the later block won, laying the export menu
  out as an 18px-gap column. Both stylesheets are one cascade; source order is the only
  tiebreak and nothing warns you.

### ⚠️ A LINTER WITH FALSE POSITIVES CAUSES BUGS

The duplicate-selector rule originally matched `^sel {` on a single line. A selector LIST
spans lines, so it read the last line of

```
.fr-empty,
.fr-note,
.fr-error {
```

as a standalone rule and reported `.fr-error` as a duplicate of itself. I believed it and
merged the two blocks — which folded `.fr-error`'s red into the SHARED base and **turned
`.fr-empty` red**. It shipped in `525092f` and was caught only when a later agent asked
about that block.

Two lessons, both now in the code: the parser accumulates the prelude across lines, and
**only a single-selector rule owns a name** — `.a, .b { }` followed by `.a { }` is a base
plus a per-variant override, which is the normal shape, not the bug. And when verifying a
CSS merge by computed style, probe every selector in the group, not the one you changed.

## What the sweep actually changed

Four report-only auditors, then four edit agents partitioned by FILE (CSS stayed with me,
since all four slices share `shell.css`). Highlights:

- **`.ds-panel` had no margin and `.ds-main` no gap**, so every page hand-typed panel
  spacing — 0, 16, 18, 22, 28. Donate typed nothing, so a signed-in supporter saw four cards
  meeting border-on-border. One rule owns it now, plus the `.ds-panel-body` class that had
  been written out as `style={{ padding: 16 }}` twelve times.
- **`.ds-panel + .ds-panel` only fires between two panels.** In Career the practice-replay
  panel is followed by the period picker, which is not one, so it had no gap below it at
  all. Panels in the page column carry the trailing half too; `.ds-main` is a block, so it
  COLLAPSES rather than doubling.
- **Layout shifts fixed**: Matchmaking jumped ~54px on FIND MATCH; the Chain start editor
  moved its inputs ~27px MID-DRAG; the top bar re-flowed a second after every page load;
  the Ranked tile grew then collapsed as `signedIn` resolved; the report dialogs' six option
  cards made a dialog into a page (537px → 366px at the same width).
- **Two inert properties**: `grid-column` on a flex child (the 3×3 catapult map never got
  its full-width row) and `.ds-opts` without `card4` (the four-card Catalyst picker wrapped
  3+1).
- **`.num` was in the practice-replay table five times and defined NOWHERE.**
- **HomeMenu used two NEGATIVE margins whose only job was to cancel its own flex gap.**
- Type debt cleared: 46 fractional px sizes → 0. The weight rule was AMENDED rather than
  enforced — `shell.css:164` documents both families as VARIABLE cuts, so 750 is real type
  and I had written that rule without reading the comment.

## Deliberately NOT done

- **Spacing CLUSTERS.** 6px (22 uses), 10px (24) and 14px (16) are 2px moves across many
  surfaces at once — a design decision, not a lint fix. Same for the 14 `10px` radii, which
  sit between `--ds-round` and `--ds-round-md`. Recorded as debt with counts.
- **ModeSelect's `.k` tile kickers** — the owner explicitly overruled deleting them.
- **`Select.tsx` migration.** 2 consumers against 5 raw `<select className="ds-select">`,
  1 `ds-input` and 3 unstyled in Admin. Product call.
- **"Rated 1v1" vs "Ranked 2v2"** for one concept (both are ELO). They ARE different
  formats — a closed party vs a premade in the open pool — so collapsing the words is a
  product decision.
- **The misscore queue's WATCH button still cannot work** — it passes a match id to a
  replay lookup, and those are different id spaces. Server-side fix, needs a deploy.
- The builder's nested gap ladder is still EIGHT values (`.ds-robot` 22 → `.ds-sec` 11 →
  `.ds-subh` ±4 → `.ds-opts` 12 → `.ds-panelbox` 15/14 → `.ds-fields` 18 → `.ds-field` 7 →
  `.ds-opt` 4). Collapsing it to five is the natural next pass, and the five sub-pickers
  that were just un-margined now depend on `.ds-panelbox`'s gap being the only separator.

## Next steps

- **Deploy** — `./scripts/fly-deploy.sh --alpha`, still outstanding for the sim strings.
- `fly secrets set` for `ADMIN_USER_IDS` is DONE on both apps; @ace (Dohun) is `owner` on
  each, verified through the public board. ⚠️ `OWNER_USER_ID` is NOT set explicitly on
  either app, so ownership still depends on list ORDER — `server/index.ts:249` falls back to
  `ADMIN_LIST[0]`, and `ADMIN_IDS` is built ONLY from `ADMIN_USER_IDS`, so naming an owner
  who is not in that list gives them the badge and no access.
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06g (a seven-slice UI audit: consistency + anti-AI-slop)

Branch **alpha**. `npm test` **ALL PASS (1286)** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. `SIM_VERSION` untouched at **2**.
⚠️ **NOT client-only: `src/sim/penalties.ts`, `src/sim/match.ts` and
`src/games/chain/penalties.ts` carry user-visible strings that changed, so the Fly server
needs a redeploy for the foul lines and the event log to match the client.**

## Previously

Seven subagents audited every user-visible string and both stylesheets, one slice each,
report-only; the rulings and the application were done centrally so the seven could not
contradict each other. The house rules they settled are now written down in CLAUDE.md
under **UI COPY** — read those before touching copy, because the two arguments that keep
recurring (dash style, failure-message shape) are decided there with the counts.

### The one ruling worth arguing with

The hyphen-vs-em-dash split was **50/50** app-wide, so it was drift, not a convention. The
tempting fix — normalise everything to `—` — is wrong for a brief that is explicitly
anti-slop, because a dash-joined appositive is the most-cited tell of machine-written
prose. Almost every one of them was two sentences. So: **full stop or colon by default,
`—` only where a dash is genuinely the right mark.** That reduces the count of BOTH glyphs.

An `Admin.tsx` comment claimed "Hyphen, not an em dash, per main's site-wide copy pass."
There is no such pass: `7a1c112` ("Polish controls and legal/footer UI copy") touched
control cards, the footer and legal casing and changed no dashes at all. The comment is
corrected.

### Real bugs the audit turned up (not copy)

- **`--ds-font` is used 13 times in `shell.css` and defined nowhere.** In a `font:`
  shorthand that is invalid at computed-value time, so the whole declaration is dropped:
  `.ds-gauge-num`, `.ds-standing-name`, `.ds-report-h` and ten others were setting no
  weight, size or line-height at all. Fixed to `--ds-font-ui`; verified in the browser that
  they now compute to 750/26px, 750/17px and 800/15px in Plus Jakarta Sans. **This is a
  visible change** — those rules start applying.
- **`.ds-dl` was declared twice** for the replay export menu and the download page, so the
  later rule turned the export menu into an 18px-gap column. Download page is `.ds-dlpage`;
  verified `.ds-dl` now computes `inline-flex / flex-end / 90px`.
- **`--accent` is defined nowhere**, so `var(--accent, #6ea8ff)` always used the literal —
  a pre-redesign blue on a themed HUD chip.
- **`.ping-graph` was the one HUD surface still hardcoded dark** (`rgba(20,24,30,.94)` +
  `--ds-line`) while its thirteen siblings use `--ds-hud`/`--ds-hud-line`.
- **`prefers-reduced-motion` capped duration but not iteration count**, so five infinite
  animations kept looping at 0.01ms each.
- **`AdminReports`' "Mark reviewed" is the punishment button.** It posts `status=reviewed`,
  which `server/index.ts:727` turns into `chargeStanding(target,'reportUpheld')`: 25
  standing, a ranked lock of 2 hours to 7 days, and 20-80 rating — while "Dismiss" beside
  it deliberately does nothing. It said "Mark reviewed", with no confirm. Now **Uphold (n)**
  with a confirm naming the charge. The three-rung SMITE got a confirm too; −100 is a
  player's entire standing.
- **`Matchmaking` rendered "That is your 3th in 24 hours."**
- **`InviteFlyout` passes `format: null`**, so an invite from a Duo Record room reaches the
  friend as "wants to play · Casual 1v1". **NOT FIXED** — needs a decision about what a
  room's format actually resolves to; it is a behaviour change, not a copy fix.

### ⚠️ STILL BROKEN, deliberately left alone

**The misscore queue's WATCH button can never work.** `AdminReports:288` calls
`onWatchReplay(r.matchId)`, but `matchId` comes from `score_reports.match_id references
matches(id)`, and the viewer looks up `replays where id = $1`. They are different id
spaces — `matches.replay_id` is its own column, which `MatchHistory` uses correctly. The
fix is server-side (project `replay_id` in `listScoreReports`) and needs a deploy, so it is
a separate change rather than something to bury in a copy pass. The button is relabelled
but still misfires.

### Also reported and NOT applied

Each is a judgement call rather than a defect, and they are listed with line numbers in
`audit-*.md` (scratchpad):

- **"Rated 1v1" vs "Ranked 2v2"** sit adjacent in the challenge picker for one concept
  (both are ELO). They ARE different formats — a closed party vs a premade in the open
  pool — so collapsing the words is a product decision, not a copy fix. ("Team up" →
  "Casual" WAS applied: that one was a second name for a format `formatLabel` already
  names.)
- Deleting the dead `.server-picker/.server-list/.server-row/.ping-dot*` families (~77
  lines) also orphans four pairs in `contrast.mjs`, so the audit count moves. Coupled
  change, left for a deliberate one. NOTE `.server-notice*` IS live — do not sweep the
  whole prefix.
- The six palette tokens with no call sites are still audited by `contrast.mjs`.
- 20 interactive elements have `:hover` and no `:focus-visible` (`.game-btn`,
  `.overlay-buttons button`, `button.ds-key` — the keybinding capture control, which is a
  keyboard-only flow). Only `.ds-dl-opt` was fixed here.
- `RobotPreview`'s `aria-label` reads raw enums to screen readers ("twinturret scorer").
- `RobotPreview`'s entire `chain` branch is dead, and is where the only read of the
  deprecated `spec.shooterRear` lives, against CLAUDE.md's "never read them".
- The snap tooltip is byte-identical in both start editors and is factually WRONG in CR,
  where snapping is live during the drag rather than on release.
- `PracticeReplays` uses a `num` class defined nowhere in the CSS (5 sites), so its score
  and length columns render in body type while every other score column is mono/tabular.

## Next steps

- **Deploy** — `./scripts/fly-deploy.sh --alpha`. Still outstanding from before this
  session too: alpha has not been redeployed since `0baeaa7`.
- The two `fly secrets set` admin lines are **still outstanding** (blocked for me):
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06f (the save reports itself honestly and stops reflowing the viewer)

Branch **alpha**. `npm test` **ALL PASS** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. Client-only. `SIM_VERSION` untouched at **2**.

## Previously

Three follow-ups on the background save, all reported together and all separate causes.

### "at 100% it doesn't show the save popup right away"

Two things, and the second was much bigger than I expected.

The readout ROUNDED UP: `Math.round` hits 100% while the last ~0.5% of frames are still going,
so the bar claimed to be done before it was. It floors now, caps at 99, and the frame loop only
owns `ENCODE_SHARE` (0.94) of the bar because the flush, the muxer and handing the browser a
multi-megabyte blob all come after it. Past that point the label reads **Finishing**.

Then the real one: the encoder queue was UNBOUNDED. The loop yielded once per frame when the
queue got deep, which never actually drains it, so the submit loop raced ahead and everything
left over was paid for in `flush()` — **measured, 3.6s of a 5.8s save**, all of it after the
bar had stopped moving. Waiting until the queue is under `MAX_QUEUE` puts that cost back inside
the loop where it is reported. The tail is now ~0.8s and the total is 7.0s for the same clip:
slightly longer overall, and the dead stretch at the end is gone. It also bounds memory, which
an unbounded queue of encoded frames does not.

### The field got squished while saving

The progress strip was its own row above the transport row, so it stole height from the canvas,
which re-fitted to a shorter box mid-recording. The strip now lives in the HEADER, replacing
the title: that row is already there and its height comes from the buttons in it, so nothing
below it moves. Measured across a whole save: header 64px, canvas box 545px, canvas backing
1280×545, all constant. **A background job must not reflow the thing it is running behind.**

### The replay jittered

Two sources, both addressed:

- the capture yielded only when its own queue was deep, so it could hold the main thread for
  long synchronous stretches and `requestAnimationFrame` cannot run inside one. It now yields
  on a TIME budget (`SLICE_MS` 8), leaving roughly half of each frame to the page.
- the playback loop accumulated unpayable debt: `n < 8` caps the steps per frame but the
  arrears keep growing, so a late frame makes the next one later. That is the classic spiral
  and it looks like judder, not like slowness. The accumulator is clamped to a few ticks, so a
  loaded machine runs the replay a hair slow instead of lurching.

⚠️ **I could not measure the smoothness itself.** The browser pane reports `document.hidden`,
which throttles `requestAnimationFrame` to 1 Hz, so frame gaps are meaningless there — and a
MessageChannel ticker fast enough to sample main-thread stalls starves the encoder it is
measuring (the same 7s save took 35.6s with the probe running). Both fixes are sound by
construction and the stall is bounded by `SLICE_MS`, but the "does it still stutter" question
needs a real visible tab.

### Copy

The menu, recording notes and refusal messages were rewritten short in the previous commit;
nothing further here.

## Next steps

- Client-only, so Vercel picks it up. **Still pending:** alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06e (the save runs in the background; MP4 is the default everywhere)

Branch **alpha**. `npm test` **ALL PASS** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. Client-only. `SIM_VERSION` untouched at **2**.

## Previously

Four asks, all in the replay export.

### The scoreboard no longer covers the field

The camera reserves a bottom band, but that is not a promise: `HUD_BOTTOM` collapses to 4px on
a short or touch layout, and the field is centred in whatever is left, so how much clear space
sits under it depends entirely on the viewer's aspect ratio. On a tall window there was room;
on a short one the bar sat on the match.

The capture now asks `fieldScreenBottom` where the field actually ENDS and gives the FRAME
`HUD_RESERVE` more height when there is not already room. Measured: a 1000×295 viewer exports
1920×676 where the unreserved frame would have been 1920×566, and the field is fully clear in
both. Growing the frame is the right move and sliding the bar onto the field is not — extra
letterbox costs nothing. The countdown centres on `fieldHeight` rather than the frame, or it
drifts toward the bar whenever the frame is extended.

### MP4 is the default, on every platform

`availableVideoFormats` preserves the table's order and the top entry is what people take, so
if that entry varies by browser then so does everybody's archive. MP4/H.264 is the one format
every platform can both produce and play, so it leads. VP9 and VP8 stay for the people who
want them, but a phone or a video editor is where these end up, and neither WebM belongs at the
top for that.

### The save runs in the background

Owning its own player, renderer and canvas means the fast path has nothing on screen to
disturb — so there was never a reason to lock playback, and now it does not. The match keeps
playing, seeking and pausing while the file encodes, with a slim progress strip above a
transport row that stays live. Verified mid-save: transport row present, seek enabled, Pause
showing, playback advanced to tick 203, strip reading "SAVING MP4 · H.264 | 98% | Cancel".

Only the REAL-TIME fallback still takes the screen, and it has to: it films the visible canvas
through `captureStream`, so scrubbing mid-record would scrub the file. Two consequences worth
keeping straight — the re-fit effect skips while `recorder.current` is live, and a finished
fast save does NOT `rebuild()`, because restarting the match under someone who is watching it
is the one thing a background job must not do.

### Plainer copy

The download menu, the recording notes and the five refusal messages were rewritten short. They
had drifted into explaining themselves at length, in a register that reads as machine-written:
"Sharpest for the file size", "re-playable in DSIM at full fidelity", "which is why it can be
saved now". The information survives; the essay does not. Code comments were left alone — that
voice is the house style the rest of this file is written in.

## Next steps

- Client-only, so Vercel picks it up. **Still pending:** alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06d (the capture stops fighting the viewer for the canvas; the video gets a scoreboard)

Branch **alpha**. `npm test` **ALL PASS** · `npm run build` · `npm run server:check` green.
Client-only. `SIM_VERSION` untouched at **2**.

## Previously

**I broke this in 2026-09-06c and the report was exact: "the field became smaller when I
started recording, and the final recording file also has a small field. Additionally, the
quality is still horrible."** One cause for all three.

The capture resized the VISIBLE canvas to the encode size. That put it in a tug-of-war it can
only lose:

1. the click sets `recording`;
2. React swaps the transport row for the taller recording bar, so the canvas's BOX shrinks;
3. the re-fit effect I had just added fires and resets the backing store to that box —
   **mid-capture**;
4. the encoder was configured ONCE, at 1920×818, so every frame after that is a ~1280×430
   canvas scaled up into the same file.

Hence a field that visibly shrinks the moment recording starts, a file with a small field, and
quality no better than before. **The capture now owns a detached canvas nobody else can
touch**, which removes the class rather than the instance. The viewer's own canvas is still
re-fitted when `recording` flips (the recording bar really is a different height), and that
effect now skips while a real-time capture is filming it.

Verified by measuring the FILE's pixels, which is what I should have done the first time —
last session I checked the output's dimensions and duration and both were right while the
content was wrong. Decoding frame 600 and scoring it against the scene re-rendered at 1920:
**41.2 dB**, against 35.5 dB for the old path. The visible canvas now reads 1280×516 in a
1280×516 box throughout the recording and 1280×545 after it.

### The video has a scoreboard now

Asked for mid-session: a live score, a final score, and the match-start lead-in. The viewer's
scoreboard is React DOM sitting ABOVE the canvas, so a canvas capture never had any of it —
which is invisible on screen, where the page supplies the other half, and leaves a file nobody
can read. `src/ui/replayOverlay.ts` draws:

- the live bar, red | phase + clock | blue, in the bands `camera.ts` already reserves so it
  cannot cover the field;
- **MATCH BEGINS IN** and the counting digit, off the sim's own `match.preCountdown`, so a
  replay reproduces the real lead-in rather than approximating it;
- END GAME split out of teleop on the same 20s the live HUD uses;
- a FINAL frame naming the winner, with a tie saying so.

⚠️ **It sets its own transform.** `Renderer.render` leaves the context in FIELD INCHES, so the
first version drew its scoreboard off in the field's coordinate space and produced a video with
nothing on it at all — the encode was fine, the overlay was simply somewhere else. It works in
CSS units, which is also what keeps the bar the same size relative to the field at every encode
resolution.

The words are `hudLabels`, deliberately split out of the drawing so they can be checked without
a canvas: four new checks cover the endgame split, the ceiling clock (a flooring one reads 0:00
for the whole last second of every phase), the tie, and a solo run having no winner.

### Measured end state

Through the real `ReplayView`, 15s of match, 1920×818, correct duration, scoreboard burned in:

| format | encode | size |
|---|---|---|
| WebM · VP9 | 3.0s (5×) | 2.56 MB |
| MP4 · H.264 | 3.0s (5×) | 1.49 MB |

### Note to self

The browser pane reports a **zero-height viewport when it is not displayed**, which collapses
every element to 0×0 — the capture then hits `recordFast`'s size guard and quietly downloads
the JSON instead. `resize_window` with an explicit size restores layout without needing the
pane in front. Two verification rounds went sideways on this before I noticed.

## Next steps

- Client-only, so Vercel picks it up. **Still pending from before:** alpha has not been
  redeployed since `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server
  runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me, so they have to be run by hand:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06c (replay video: MP4 stops being slow, and the quality problem was resolution)

Branch **alpha**. `npm test` **ALL PASS** · `npm run build` · `npm run server:check` green.
Client-only — no sim, no server, no migration. `SIM_VERSION` untouched at **2**.

## Previously

Two complaints, and they turned out to have one cause between them and one cause apart.

### "MP4 downloads are way too slow" — it had no CONTAINER, not a slow encoder

MP4 was the last format still going through `MediaRecorder`, which cannot beat real time (it
stamps frames by when they ARRIVE, not by the stamp the frame carries), so a 2:42 match took
2:42 to save. The reason it was still there was stated as "muxing H.264 is a second CONTAINER,
not a second encoder" — true, and the answer was simply to write the container.

`src/ui/mp4.ts` is that: a minimal ISO-BMFF muxer, one H.264 track, no fragments, no audio, the
twin of `webm.ts`. **MP4 now encodes at exactly the same 5× as WebM** — measured through the
real `ReplayView`, 15s of match in 3.0s, in all three formats, each reading back at the right
duration and decoding.

Two things in that file are easy to get wrong and silent when you do, so they are asserted
headlessly in `npm test` (the muxer is pure — it needs no browser even though the encoder
feeding it does):

- `stco` holds ABSOLUTE FILE OFFSETS, so `moov` cannot be written until its own length is
  known. It is built TWICE — measure, then write — which is safe only because the offset is a
  fixed-width field. Off by one byte and you get a file that opens, reports the right duration
  and decodes garbage.
- Chunks arrive in DECODE order. Today's browser encoders emit no B-frames, but writing the
  file as though none could is a different claim, so `ctts` is emitted when (and only when)
  presentation and decode order actually differ.

### "video quality for the two webms is horrible" — it was RESOLUTION, and I nearly fixed the wrong thing

The obvious suspects were the rate control and the `latencyMode: 'realtime'` that shipped. I
built a bench that encodes the same 7s of real match and scores each result as PSNR against the
scene re-rendered at 1920. Both suspects are nearly irrelevant:

| | bitrate | PSNR |
|---|---|---|
| **old path** (render 2496×1074 → `drawImage` to 1280, realtime) | 1.84 Mbps | **35.5 dB** |
| 1920 native, quantizer 34 | 1.52 Mbps | 42.25 dB |
| 1920 native, quantizer 22 | 1.88 Mbps | 42.40 dB |
| 1920 native, quantizer 10 | 2.47 Mbps | 42.55 dB |

**Nearly seven dB, all of it from drawing the frame at the size it is encoded at.** Sweeping
the quantizer across its whole useful range moves 0.3 dB and 1.6× the file size. (The ~42.5 dB
ceiling is 4:2:0 chroma subsampling; no encoder setting buys it back.) A >2× canvas downscale
is a cheap bilinear filter and it lands on exactly the thin tape lines and the small scoreboard
type.

So `encodeSize` is now a RENDER size, not a downsample target: the capture retargets
`camera.dpr` and draws straight into a canvas of that size. `MAX_EDGE` is 1920 — the same
encoder that accepted 1920 for H.264 refused 2496.

⚠️ **Three things I got wrong on the way, all worth keeping:**

1. **`encodeSize` clamped the scale at 1×**, so on a 1280-wide window it produced a 1280-wide
   video — precisely the resolution being blamed. It has to scale UP to the target too. Caught
   only because I checked the output dimensions of a real download rather than assuming.
2. **The quantizer option is CODEC-SCOPED** — `{ vp9: { quantizer } }`, not `{ quantizer }`. A
   flat one is accepted silently and ignored, which reads exactly like an encoder that does not
   honour the setting. It cost a whole measurement round; the giveaway was three identical file
   sizes across a q sweep.
3. **The canvas was left stale after a capture** (drawing a 1280×516 field into a 1280×545 box,
   stretched 5%). Two causes, neither of which fires a window resize: the capture leaves the
   backing store at the video's resolution, and the recording bar replaces the transport row at
   a different height. Re-fitted in an effect on `recording` — NOT a per-frame check, which
   would force a layout flush 60 times a second for something that changes twice a match.

Also: `availableVideoFormats` is now **async**, because the honest question is not "is there a
`VideoEncoder`" but "will it take this codec at this size" — and that is what decides whether
MP4 saves in seconds or has to be filmed, which the menu states. `videoFormat(id)` still
answers synchronously off the static table, because the download filename is built from
`fmt.ext` before the probe lands. The menu's cost label is computed from the match length now
instead of a hardcoded "~10s" that was a lie about anything longer than the clip it was
written against.

### Measured end state

Through the real `ReplayView`, 15s of match, all at 1920×818 and correct duration:

| format | encode | size |
|---|---|---|
| WebM · VP9 | 3.0s (5×) | 2.5 MB |
| WebM · VP8 | 3.0s (5×) | 4.0 MB |
| MP4 · H.264 | 3.0s (5×) | 1.45 MB |

## Next steps

- **Nothing here needs a deploy** — it is all client-side, so Vercel picks it up. The pending
  server work from the previous session still stands: alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me by the permission classifier, so they have to be run by hand:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris still in the tree: `scripts/zz-probe-*`, `scripts/zzprobe_*`,
  `scratch_penalties_backup.ts`.
- Still open from earlier: two-account cross-region challenge check, an end-to-end practice
  upload from a signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit,
  CR `APPROX` constants.

---

# HANDOFF — 2026-09-06b (the pusher stops steering itself; pins stop needing a struggle)

Branch **alpha**, pushed + deployed. `npm test` **1272, ALL PASS** · build · `server:check` green.
`SIM_VERSION` stays **2** (alpha is ONE unreleased batch past main; both changes are inside it).

## Previously

**"I turn with them and follow them" was literally true, and it was the SETTLING term.**
`squareUpPair` turns BOTH chassis flush to the SHARED contact normal. The normal belongs to the
PAIR, so a turning victim rotated it and the pusher was turned to keep up. Measured: a pusher
commanding nothing but straight forward copied its victim's heading at **102-110%** and rode it
72in across the field still touching.

Fix is the one `CONTACT_PAIR_SPIN`'s own note already named — "a contact that can slip". The
settling `align` is scaled by `1 / (1 + slip / CONTACT_SLIP_RELIEF)`, slip measured at the
contact point WITH ω×r (a pivoting chassis slips without either centre moving). The two cases
are nowhere near each other, which is why this works cleanly:

| pair state | slip | settling |
|---|---|---|
| held / idle (settling SHOULD work) | **0.0 in/s** | untouched |
| victim strafing off | 5.7 avg | faded |
| victim turning + strafing | 9.6 avg (peak 36.6) | faded |

Tracking **105% → 21%**. ω×r is safe HERE and not in `press` because it enters as a MAGNITUDE
that only attenuates — no sign to flip, so it cannot cause the documented limit cycle.

**G422 no longer needs the victim to be struggling.** Reading "attempting to move" as "the
stick is deflected this tick" is what kept the foul rare — people held against a wall stop
working the stick long before they stop being held, and a ref cannot see a stick. The guard
that REPLACES it is on the pinner (`PIN_PRESS_COS`): it must be driving INTO the victim, since
`rrContacts` is overlap-only and says nothing about who holds whom. Idle victim **0 → 3 MINORs
/ 12 s**; an idle opponent, one strafing past, and a self-trapping victim all still draw 0.
⚠️ This is a deliberate DEVIATION from the rule text, like `POSSESSION_REBILL_S`.

## Gotchas

- One existing check asserted the OPPOSITE ("a victim commanding nothing at all is not being
  pinned"). Rewritten, with the pinner-side guards added beside it — do not "restore" it.
- Still true from 06a: **a tank pusher given only `driveY` does not move** (it reads the side
  sticks), which silently turns "held against a wall" into "standing near a wall".

## Next steps

1. Drive it and see whether the pusher still feels sticky — `CONTACT_SLIP_RELIEF` (4) is the
   dial; LOWER lets go sooner. A pure pivot still drags the pusher ~88%, which is arguably real
   but is the next thing to look at if it feels wrong.
2. The into-wall escape cliff from 06a is untouched and is Coulomb stick/slip, not a bug.
3. Still open: the two `fly secrets set` admin lines, the two-account cross-region challenge
   check, an end-to-end practice upload, Rapier slice 2, penalty HITBOX audit, CR `APPROX`.

---

## HANDOFF — 2026-09-06a (G422 wall pin + what the push measurements actually say)

Branch **alpha**, pushed. `npm test` **1269, ALL PASS** · build · `server:check` green.
`SIM_VERSION` stays **2** on purpose (see its note: alpha is ONE unreleased batch past main).

## READ FIRST

**Two reported claims, both measured on BOTH branches rather than reasoned about.**

1. *"a pushed robot cannot escape, even strafing"* — TRUE on main, largely FIXED on alpha by
   the shove rework. Equal chassis, victim against a wall, pure strafe for 6 s:
   **main 6.8in → alpha 37.2in**. What remains on alpha is real Coulomb stick/slip: the
   victim's OWN into-wall command adds to the normal force, so escape collapses
   **37in (0 forward) → 23.6in (0.1) → 1.9in (0.2) → 0in (1.0)**. Lowering wall friction only
   MOVES that threshold (swept 0.5/0.3/0.15/0.05), it does not remove it. Left alone — pressing
   yourself into the wall making it worse is honest; tell me if it should be softened.
2. *"pinning penalties almost never fire"* — TRUE, and alpha was WORSE THAN MAIN. Fixed.

**The G422 bug: the obstruction test only understood a straight reverse.** It asked whether the
PINNER lay along where the victim was trying to go — true of reversing, false of every SIDEWAYS
exit. Every existing test had the victim reverse, so nothing caught it. A victim held flat on
the wall and strafing billed **0** where main billed **1**. It now tests the VICTIM'S intent
(`PIN_INTO_TRAP_COS`): the only excluded case is driving further INTO the trap, which is the
self-pinning scene the original test existed for (that check still passes). Success is then
measured by `PIN_STUCK_SPEED` + criteria A/B — prevention is an outcome, not a stick direction.
After: heavy tank holding a victim on the wall **6 MINORs / 20 s**; weak x-drive it strafes
clear of **2**.

## Gotchas hit (both cost real time)

- **A TANK PUSHER GIVEN ONLY `driveY` DOES NOT MOVE.** Tank reads `leftDrive`/`rightDrive`
  only, so half my first probe measured a victim nobody was holding and reported a free
  escape. Any pin/push scene with a tank must drive the side sticks.
- **`git worktree remove --force` FOLLOWED A DIRECTORY JUNCTION** I had made inside the
  worktree to share `node_modules`, and emptied the real one. Recovered with `npm ci` (no
  lockfile churn). Do not junction node_modules into a worktree you intend to remove.
- `PHYS_FRICTION` is NOT the walls — `statics()` never called `setFriction`, so walls ran on
  Rapier's default 0.5 (effective 0.6 by the AVERAGE combine rule) while the constant's comment
  claimed it covered them. Now stated as `PHYS_WALL_FRICTION` at the same value; verified a
  no-op by the full suite.

## Next steps

1. Decide whether the into-wall escape cliff should be softened — it is a balance call, and the
   lever is `PHYS_WALL_FRICTION` (moves the threshold) not a bug fix.
2. Still open: the two `fly secrets set` admin lines, the two-account cross-region challenge
   check, an end-to-end practice upload from a signed-in account, Rapier slice 2, the penalty
   HITBOX audit, CR `APPROX` values.

---

## HANDOFF — 2026-09-05b (solo practice runs are kept and rewatchable)

Branch **alpha**, at `1cc016d`, pushed. `npm test` **1264, ALL PASS** · `npm run dbtest` ALL PASS
(+9 practice checks) · `npm run build` · `npm run server:check` · `npm run contrast` 221 ·
`npm run test:mm` 58 — all green. `SIM_VERSION` stays **2**, `BALANCE_VERSION` stays 4.

Do not merge to main. Standing rule.

## READ FIRST

**"Solo practice" is the OFFLINE FULL MATCH (`mode: 'match'`, `session: null`), not Free
Drive.** I spent a whole round assuming Free Drive and asking questions about where an endless
session begins and ends. It is the `Solo Practice` tile in `ModeSelect`; Free Drive is the tile
next to it. Solo practice has a real end (`post`), which is why none of that mattered.

**It could not just be recorded.** `replay.ts` states the invariant: a run must be fully
SIM-DRIVEN (preCountdown → auto → … → post) so `{seed, setups, commands}` alone reproduce it.
Solo practice started from the CONTROLLER (`countdownStart` vs `world.time`, calling
`startMatch(world)` directly), so the tick auto began on depended on a keypress the container
cannot store — a recording would have diverged from tick 0. `startMatch()` now rebuilds the
world at tick 0 and sets `preCountdown`; the rebuild is invisible (`robotsEnabled` is false in
`pre`) and reuses the seed. Solo also steps on `localizeCommand(cmd)` now, since a replay
stores quantized commands.

## What landed (`1cc016d`)

- `src/game.ts` — sim-driven solo countdown, `ReplayRecorder` over `stepSolo`, finalize at
  `post` → `onPracticeRun`. `getPracticeRun()` is deliberately separate from `getMatchResult()`,
  which is documented as the SERVER's authoritative payload.
- `src/net/practiceRuns.ts` — localStorage ring (index + one body per run), cap 10, evicts and
  retries on quota. Works signed out.
- migration `0032_practice_runs.sql` + `savePracticeRun`/`listPracticeRuns`/`PRACTICE_KEEP`,
  `POST|GET /api/practice` (owner-only), `sanitizeReplay` on ingress.
- `src/ui/PracticeReplays.tsx` in Career (self-only, via `Stats`' `head` slot like
  `StandingCard`), ▶ WATCH REPLAY on the solo results screen.

## Verified

Headless: 4 new smoke checks pin that the sim-driven shape reproduces (world hash AND match
clock) and that the old controller-driven shape does NOT. 9 dbtest checks pin the prune, the
orphaned-replay cleanup, account deletion, and — the load-bearing one — that a practice run
never appears on the record leaderboard.

In-browser: drove `GameController` directly (the pane starves rAF, so a real 2:30 match will
not run there) — `startMatch` opens the recorder at tick 0, reaching `post` yields a replay,
the local save lands in localStorage, Career lists it, and ▶ Watch opens the viewer.

## Gotchas hit

- **Two ways to write a VACUOUS replay check**, both hit here: `DEFAULT_ASSISTS.fieldCentric`
  is TRUE so a steer-and-drive-forward scene parks in a corner and any two runs then agree; and
  `worldHash` does NOT cover `match.phase`/`phaseTimeLeft`, so runs that started 200 ticks
  apart hash the same. Assert movement + score, and compare the clock.
- The Browser pane starves `requestAnimationFrame` when it is not painting — `world.tick` sat
  at 0 and it looked exactly like a bug in the countdown change. A screenshot forces one burst
  of frames; `document.visibilityState` still reads "visible", so that is not the tell.
- Synthetic `KeyboardEvent`s do not reach `InputManager`; use `computer` `key`.

## Next steps

1. Confirm an upload end-to-end once alpha is redeployed (the route + 0032 shipped with this;
   deploy was started at the end of this session — verify `/api/practice` returns 401 signed
   out rather than 404).
2. Still open: the two `fly secrets set` admin lines from the previous section, the two-account
   cross-region challenge check, Rapier slice 2, the penalty HITBOX audit, CR `APPROX` values.
3. The `scripts/zz-probe-*` files and `scratch_penalties_backup.ts` are untracked G408 debris.

---

## HANDOFF — 2026-09-05 (replay downloads + the cross-region room split)

Branch **alpha**, at `b52fca0`, pushed. `npm test` **1260 checks, ALL PASS** · `npm run build`
green · `npm run server:check` green · `npm run contrast` 221 green · `npm run dbtest` **green
again** (it had been red — see below). `SIM_VERSION` stays **2**; `BALANCE_VERSION` stays 4.

Do not merge to main. Standing rule.

## READ FIRST

**"Replay unavailable" on the deployed alpha server was a MISSING DEPLOY, not a code bug.**
`dsim-alpha` was last released **Aug 26** (v11) — before `8b046dc`, which added migration
`0031_replay_behaviour_version.sql`. So the live `getReplay` had no `behaviour_version` column
to read, could not populate `Replay.sim`, an absent `sim` read as 0, and every replay was
refused. Deployed via `./scripts/fly-deploy.sh --alpha`; `/api/replay/<id>` now returns 200 with
the column in the select, so 0031 ran. **A replay change is a SERVER change.**

**That fixes NEW runs only, and that is correct.** Every replay currently on the alpha board was
recorded at `BALANCE_VERSION` **3** (July–August, format 1, no `sim` stamp); alpha is on **4**
since `7ea642b` reworked the shove. Those stay refused because the balance really did change —
what changed is that the viewer now says so instead of "recorded on an older version of the sim
(Season 3)". Runs recorded from now on stamp `bv 4 / sim 2` and play and download normally.

## OPEN — the admin change could not be applied

The user asked to drop **baron** as an admin and add **`5baefc21-e1e8-43b0-9278-4af2ea150882`**
(solver / @featurescript) on both servers. `flyctl secrets set` is REFUSED by the Claude Code
auto-mode classifier, so this is still to do BY HAND:

```
fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'
fly secrets set -a dsim-alpha       ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'
```

Resolved from the live lists (`fly ssh console -C "printenv ADMIN_USER_IDS"` + `/api/user/<id>`):
`e3d73282`=Fe/@felix, `0c9c1654`=Dohun Kim/@ace (owner), `a509c53d`=**baron** (dropped).
Baron was an admin on MAIN ONLY — alpha's list was just the owner, so alpha only gains solver.
`OWNER_USER_ID` is set explicitly on both, so list ORDER carries no meaning here.

Two things to check afterwards: `syncStaffRoles` runs once per boot and the sweep is SYMMETRIC,
so a restart is what actually strips baron's badge and perks — confirm with
`/api/user/a509c53d-dc89-4dae-99de-2c6e30e537d9` returning no `role`. And a secrets set restarts
machines, which on MAIN can re-apply fly.toml's single `[[vm]]` to every one of them; sizes
before the change were **iad shared-4x/1024, lhr+sjc+syd+nrt shared-1x/1024**, so re-shrink with
`scripts/fly-deploy.sh`'s satellite loop if `fly machine list -a dohun-sim-decode` disagrees.
There were 7 players online (1 queued) when this was attempted; `scripts/announce-deploy.sh`
needs an `ADMIN_SECRET` this session is not allowed to read.

## What landed

- **`replayRefusal`** (`src/sim/replay.ts`) names WHICH refusal: `future` (they are behind —
  refresh) · `balance` · `behaviour` · `unstamped` · `tank`. `replayPlayable` is `=== null` over
  it, so the yes/no policy is byte-identical — `unstamped` is a MESSAGE split, the test stays
  `(r.sim ?? 0) !== simVersion`, and smoke pins that a build on SIM_VERSION 0 still accepts an
  unstamped log (which is what keeps the format-1 mecanum case playable).
  **The old copy was wrong three ways at once**: it printed `balanceVersion` as "Season N" (in
  `replays`, the SEASON is the `balance_version` COLUMN and that number is in `sim_version`), it
  called a FUTURE container old, and it asserted a specific mismatch for an unknown one.
- **The exports are a header MENU** (`.ds-dl`), not two ghost buttons in the transport row —
  they are actions on the replay, not on playback. Each option states its COST, which is the
  thing that decides between them: the video takes the full match in real time (the menu prints
  the actual figure), the JSON is instant and prints its size. No `MediaRecorder` ⇒ the video
  option renders DISABLED with a reason, instead of silently falling back.
- **Recording replaces the transport row** (`.ds-replay-rec`): red dot, progress bar, real time
  remaining, the "keep this tab in front" warning, Cancel. Locking four controls and showing
  "● REC 12%" did not explain why they were locked.
- **`npm run dbtest` was RED** and had been since the interim readable/exact design was reverted
  — `scripts/dbtest.ts` still called `replayReadable`, and because it is a dynamic
  `await import`, tsc never saw it. Now uses `replayPlayable`/`replayRefusal`, and the pre-0031
  row check asserts `unstamped` against a REAL row.

## Verified in the browser (pane, not Electron)

Stubbed `window.fetch` for `/api/replay/` with a container generated by `runRecordMatch` on this
build, then routed to `/decode/replay/<id>`. Menu + recording bar in **both themes**; outside
click and Escape close the menu; all four refusal texts render and the Download button is absent
on the stale screen; at **375×812** the popover is 339px with no horizontal overflow and the
recording bar wraps to three rows. Cancel discards and restores the transport row.

## Gotchas hit

- A Bash **heredoc** carrying the whole TSX truncated silently mid-file (CRLF terminator). Write
  the file with the Write tool and convert endings with python instead.
- `CLAUDE.md` and `scripts/smoke.ts` had drifted to **LF**; `core.autocrlf=true` normalizes on
  commit, but re-CRLF the working copy or every later diff warns.
- `git status --short --cached` is not a thing (`--cached` is a `diff` flag) and it aborted a
  chained commit — the commit silently did not run.

## Also landed — the cross-region room split (`a71af95`)

**Two friends on different servers who accepted the same challenge got two rooms with one
code.** A custom room code is BARE (a staged room is `iad-abc123`; a shared code carries
nothing), so a socket with no `?region=` hint lands on the machine nearest to the JOINER, which
has no such room and opens an empty one with the same code. Neither side is told.

The invite has carried the host's region since migration `0029` and `App.onJoinInvite` passed
it on. Two client paths dropped it:
- `InviteFlyout` — the accept button you use while ALREADY in the lobby — called
  `onJoinRoom(code)` with no region, so the join used our own server.
- `Lobby` read the region from a `useState` seeded at mount, and accepting from that flyout
  does not remount it, so a correct prop would not have been re-read either.
- ...and inviting a friend from inside a room stamped NO region on the invite (the 7th arg was
  simply omitted) — the same split from the other side.

Now `Lobby.join(code, hostRegion?)` takes it as an argument, `roomJoinRegion` (`src/net/
roomRegion.ts`, a leaf so smoke can import it — `env.ts` reads `import.meta.env` at load) is
the rule, and the auto-join guard keys on the CODE instead of a never-reset `useRef(false)`
that silently swallowed a second accept. 5 smoke checks. Server side needed nothing.

**Verified**: the URL builder returns `wss://…?region=lhr` for a host on lhr while our own pick
is iad, and creating a room still opens a real socket on the picker's region (live, dev pane).
**NOT verified end-to-end** — that needs two signed-in accounts on two regions. Existing invite
rows have `region` NULL and will still split, but `INVITE_TTL_S` is 10 min, so that clears
itself.

## Next steps

1. Apply the two `fly secrets set` lines above (see the OPEN section).
2. Confirm the challenge fix with two accounts on two different regions — the one link the
   dev-pane check cannot reach.
3. Watch for the first NEW alpha record run and confirm its replay plays + downloads end to end.
   That is the one link still only verified by `dbtest` and the 200 from `/api/replay`, not live.
4. The `scripts/zz-probe-*` files and `scratch_penalties_backup.ts` are untracked G408 debris
   from the previous session; delete when nothing else needs them.
5. Still open from before: Rapier slice 2 (balls), the DECODE penalty HITBOX audit (zone geometry
   vs the manual figures — G408 and G422 text are done), CR `APPROX` constants.

---

## HANDOFF — 2026-08-25 (the mouth carve-out vs the player's own assists) — alpha only

Branch **alpha**. `npm test` **1167 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 8 → **9**.

Do not merge to main. Standing rule.

## READ FIRST

**Every G408 scene in smoke used `DEFAULT_ASSISTS`. Real players use `PLAYER_ASSISTS`, which has
auto-intake AND auto-fire ON.** The rule behaved completely differently there, and that gap is
why four rounds of "still not getting the penalty" kept coming back negative.

Nine-clump herded in open space, identical push:

| assists | fouls | artifacts excused per tick |
|---|---|---|
| auto-intake OFF | **15** | 0 |
| auto-intake ON (the default) | **2** | **3** |

The mouth carve-out was bounded by hopper **ROOM**. Auto-fire keeps all three slots empty and
auto-intake keeps `intaking` true, so three artifacts were excused on every tick, forever — the
exact failure the constant's own doc comment warned about and believed `POSSESSION_ACQUIRE_S`
had fixed. It had not: that window is keyed on the herding clock, which barely advances in open
space, so the excused artifacts never aged out.

**Now capped at what the rollers take in one cycle** — one artifact, two for a triangle's twin
slots — which is what the exemption was ever meant to model.

## The honest remaining behaviour

A robot with auto-intake still controls FEWER artifacts than one without, because it is eating
the pile as it pushes. That is the count being truthful, not a bug. It is also exactly why the
perimeter is where players notice the rule at all: against a wall the artifacts pile up faster
than the intake can swallow them, so four or more stay in contact.

If open-space herding should bite harder for an intaking robot, the lever is NOT G408 — it is
that a robot pushing a clump in this sim also consumes it. Changing that is an intake/feel
change, not a penalty change.

## The whole chain of causes, for the record

Four rounds, four different faults, none of them the rule text:
1. the model was built on FRC definitions not in the DECODE manual (2026-08-25a);
2. it was too eager about artifacts already at a wall (2026-08-25b);
3. an artifact only counted on ticks it was touching, so steering killed it (2026-08-25c);
4. penalties did not run in Free Drive at all (2026-08-25d);
5. and the mouth carve-out was permanently open for anyone using the default assists (this one).

**Lesson: reproduce with the PLAYER'S configuration before tuning.** `DEFAULT_ASSISTS` is the
neutral sim/wire fallback; `PLAYER_ASSISTS` is what a person actually drives with, and the two
differ on auto-intake and auto-fire. A smoke suite written entirely against the former can be
green while the feature is dead in play.

---

## 2026-08-25d — penalties were OFF in Free Drive (superseded as READ FIRST)

Branch **alpha**. `npm test` **1166 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 7 → **8**.

Do not merge to main. Standing rule.

## READ FIRST — the actual answer to three rounds of "I'm not getting the penalty"

**The entire penalty engine was switched off in Free Drive.** `updatePenalties` returned early
for any phase that is not `auto` or `teleop`, and Free Drive runs in `freeplay`. Measured on an
identical six-clump herd:

| mode | phase | fouls |
|---|---|---|
| Free Drive | `freeplay` | **0** |
| Match | `teleop` | **13** |

`freeplay` is a live phase everywhere ELSE in the sim — `robotsEnabled` includes it, the human
player restocks in it, the shooter fires in it. Penalties were the one subsystem that excluded
it. So every round of G408 tuning was invisible to anyone practising in Free Drive, which is
exactly where you would go to practise pushing a clump around.

Now assessed in `freeplay` too. Phase-specific rules stay correctly inert on their own terms:
G402 tests `phase === 'auto'`, `endgame` tests `phase === 'teleop'`. CR is untouched —
`updateChainPenalties` gates on `isAuto`/`isTeleop` explicitly, which is right for G05/G06.

**Checked for spam**: 45 s of ordinary free driving with practice dummies drew 0 fouls on the
player. A passive dummy can never be PINNED either, since G422 needs the victim attempting to
move and a passive robot issues no command. The only event was a G426 against a dummy parked in
a loading zone, which is correct.

## Lesson for next time

Three sessions were spent tuning a rule that could not fire in the mode it was being tested in.
**Before tuning a sim rule, confirm the rule RUNS in the mode the report came from.** The
phase gate at the top of `updatePenalties` is the first thing to check, and `robotsEnabled`
(`src/sim/match.ts`) is the list of phases the rest of the sim considers live — any subsystem
whose phase list disagrees with it is a suspect.

---

## 2026-08-25c — making CONTROL reachable again (superseded as READ FIRST)

Branch **alpha**. `npm test` **1165 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 6 → **7**.

Do not merge to main. Standing rule.

## READ FIRST

The leniency pass below (2026-08-25b) went too far the other way: *"when I just push a clump in
open space it doesn't give me [the penalty]"*. Fixed, and the cause was not a threshold.

### An artifact only counted on the ticks it was TOUCHING

Artifacts do not RIDE a bumper in this sim — they bounce off it and are re-struck — so a herded
pile is in contact only intermittently. `held.add()` happened solely on touching ticks, so the
count collapsed to whatever was in the hopper between bounces. Measured, with a six-clump in
open space:

| driving | ticks controlling >3 | fouls |
|---|---|---|
| dead straight | 89% | 9 |
| gentle steer (±0.15) | **4%** | **0** |
| hard weave (±0.3 @2 Hz) | **0%** | **0** |

So the rule worked only if you drove perfectly straight. **An established hold now keeps
counting while it DRAINS**, so a re-struck artifact stays controlled between bounces; the drain
is what bounds it (an artifact stops counting a couple of confirm windows after the robot really
has left it, and one that never established has nothing to drain). `POSSESSION_CARRY_DIST` is
now sticky too — across re-stations and across the hold dying — because ground already covered
does not un-happen. `POSSESSION_CONFIRM` 0.8 → **0.65**.

Neither `POSSESSION_LEAK` nor `POSSESSION_CONFIRM` could fix this on their own; both were swept
(0.12–0.5 and 0.35–0.8) and the steering cases stayed at zero. It was never a threshold.

### Where the line sits now

Clean: nosing into an open clump however deep · driving into 5 artifacts already on the wall,
even leaning 20 s · nosing a 9-row at the wall at half throttle · collecting 3 with an empty
hopper · driving past artifacts strung along a lane · parked among artifacts.

Fouls: herding 5–6 across open floor straight, steering, or with the throttle wobbling ·
driving a pile INTO the wall and leaning · spinning a corralled pile · **ramming a 9-row at full
throttle and scattering it 40 in**.

That last pair is one boundary, and both sides are pinned in smoke: a half-throttle press
displaces the outer artifacts 33–39 in and draws NOTHING, because they squirt sideways out of
the squeeze rather than covering ground in the push direction; the full-throttle ram carries
four of them past the carry distance and costs three MINORs.

### Known limit

A robot WEAVING hard while pushing bats the clump apart and then genuinely controls only its own
three, so it draws nothing. That is the count being honest rather than the rule failing — but it
does mean a flailing robot is cheaper than a tidy one. If that ever matters, the fix is in the
ball–robot contact feel (how far a turning bumper flings artifacts), not in G408.

### Gotcha that cost time here

A `sed` on `cmd({ driveY: 1, intake })` matched an identical line inside an unrelated `gateHold`
helper and broke the suite at check 538. **`npm test` printing no FAIL is not proof it passed** —
it can die partway. Check the count, or the `ALL PASS` line at the end.

---

## 2026-08-25b — making CONTROL lenient about running into things (superseded as READ FIRST)

Branch **alpha**. `npm test` **1162 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 5 → **6**.

Do not merge to main. Standing rule.

## READ FIRST

The CONTROL rewrite below (2026-08-25a) was right about the definition and too eager in play.
Two false positives were reported and both are fixed:

* *"if you drive into a pile to intake, you get a penalty if you go in too far"*
* *"you get a penalty if you drive into five balls that are ALREADY at the wall"*

### The fix: "MOVING the SCORING ELEMENT" is a DISTANCE, and it is DIRECTIONAL

Clause B's verb is about the artifact, so it has to have actually gone somewhere. The new
`POSSESSION_CARRY_DIST` (5 in, one artifact diameter) accumulates per tick as
`max(0, b.vel · pushDir) * dt`, where `pushDir` is the direction the robot's contact point is
travelling.

**The projection is the whole trick.** A row already resting on the perimeter squirts SIDEWAYS
out of the squeeze — fast, but covering no ground in the direction the robot is driving it. A
herded pile covers it steadily. So running into things is free and taking them somewhere is not,
and a pile the robot DROVE to the wall still counts through the latch.

Two things that do NOT work, both measured before landing this:

* **an instantaneous speed floor** (what main used, and the obvious first try). Artifacts do not
  RIDE a bumper in this sim — they bounce off and are re-struck — so a jammed pile reads as
  moving quickly while going nowhere. At the ball's own rest threshold it still billed 6 MINORs
  for driving into a wall row.
* **undirected net travel.** A wall row scatters sideways plenty; only the projection separates
  it from a herd.

`POSSESSION_CONFIRM` also went 0.35 → 0.8 s. Contact plus a fifth of a second cannot tell
"taking these somewhere" from "arriving among them". Swept over the thirteen scenes in the probe,
**0.8 s with a 5 in carry is the only pair where every case comes out right** — 0.35 fouls the
intake cases, and a longer carry starts letting real herding through.

### Where the line now sits

| scene | fouls |
|---|---|
| nose into an open clump to intake, however deep | no |
| drive into 5 artifacts already on the wall, even leaning 20 s | no |
| nose into a 9-row on the wall with the intake held | no |
| parked among artifacts, never pushed | no |
| herd a 5- or 6-pile across open floor | **yes** |
| drive a pile INTO the wall and lean on it | **yes** (the latch) |
| corral a pile and spin in place | **yes** |
| RAM a wall row from 40 in away, scattering it | **yes** — see below |

That last one is a deliberate judgement call: it covers the carry distance in the push direction
because it really did move those artifacts 40 in. The line is displacement, not intent.

### Smoke scenes: two more were unsound

The `clump` helper parked unused artifacts at (900,900). Anything outside the perimeter is
dragged back in by the containment pass in world.ts, so they reappeared on the field and the
robot met them later — a THREE-artifact clump was drawing a foul off a stray. Unused artifacts
are now REMOVED from `world.balls`, and the squirting-ball scene clears the field too. Scene
durations are now derived from the gates (`acquireSecs`/`acquireTicks`) instead of hard-coded
from the old constants.

### Gotcha

`world.penalties` still has no `unslimWorld` backfill. `ballCarry` is therefore declared
**optional** and read through `??=`; a snapshot from an older server arrives without it and the
first index would otherwise throw. Any future `PenaltyState` field needs the same treatment.

---

## 2026-08-25a — what CONTROL actually is (superseded as READ FIRST)

Branch **alpha**, commit `9f8e633`, pushed. Working tree CLEAN (bar the untracked `zz-probe-*`
scratch scripts). `npm test` **1159 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green.
**Deployed to the alpha preview** (`dsim-alpha`, `deployment-01M0WAB0NBK0E3FQD9FWX8A59Q`,
1/1 checks, `/health` ok). Production untouched.

Do not merge to main. Standing rule.

## READ FIRST — where this session ended

G408 over-possession, rewritten from the manual's own text. `SIM_VERSION` 4 → **5**.
`BALANCE_VERSION` left at **4** (see *Open*).

### The finding: the engine was built on two definitions that are not in the DECODE manual

`controlledArtifacts` was written against an FRC-style **POSSESSION** ("as the ROBOT moves or
changes ORIENTATION ... the object remains in approximately the same position relative to the
ROBOT") and a **TRAPPING** ("preventing the movement of a SCORING ELEMENT against a FIELD
element"), both quoted in the code as if they were DECODE's. Verified by extracting Sections 11
and 16 of the archived manual and grepping both:

* there is **no POSSESSION glossary entry**; the only occurrence of the word in Section 11 is
  G404's "pre-load possession limit";
* there is **no TRAPPING glossary entry**, and the word does not appear in Section 11 at all.
  The quoted definition is DECODE's **PIN/PINNING** with "opponent ROBOT" swapped for "SCORING
  ELEMENT";
* "bulldozing" and "deflecting" are not glossary terms either — they exist only as G408's own
  non-CONTROL examples.

DECODE defines exactly one term, **CONTROL**, and the rewrite is written against it clause by
clause. See the G408 bullet in CLAUDE.md for the full mapping.

### What changed behaviourally

| | before | after |
|---|---|---|
| a pile CREPT below 1.5 in/s | 0 fouls over 12 s | controlled (no speed floor in the definition) |
| a pile driven into a wall and held | 4 MINORs, then free all match | keeps billing (the LATCH) |
| a robot parked near a wall, never pushed anything | fouled by the invented TRAPPING rule | clean |
| artifacts off a convex CORNER | counted | not control (clause B names the face) |
| anything inside your own loading zone | never counted, robot anywhere | only while the ROBOT is in there |
| an artifact excused at the mouth | re-added by the transitive chain | conducts, not counted |
| first continuing tariff | 2 × REBILL_S (measured 6.02 s) | one interval after the violation opens |
| per-(robot,artifact) clocks | leaked forever, ids recycle | swept, and cleared outside auto/teleop |
| the acquire carve-out | raw intake button only | `cmd.intake \|\| r.autoIntake`, as robot.ts does |

### ⚠️ ONE DELIBERATE DEVIATION, now labelled as one

`POSSESSION_REBILL_S` — the "another tariff every 3 s" rule — **is not in G408**. Its violation
line is one assessment. The same manual writes the continuing clause three times (G422, G423,
G434) at exactly this interval, and G434's is the identical per-artifact shape, so the omission
from G408 reads as deliberate. It is kept because you asked for it ("the over-possession penalty
is way too lenient") and because billed once the whole tariff for hoarding six artifacts was
three MINORs and then free. **Set `POSSESSION_REBILL_S` to `Infinity` for the rule as written.**
Measured cost of keeping it: leaning a six-pile on a wall for 30 s now bills **40 MINORs**
(200 pts). That is the dial to turn if it reads as too harsh.

### Two smoke scenes were mislabelled and are now fixed

Both were passing for the wrong reason, and both hid behind the invented TRAPPING rule:

* *"pushing a clump across open floor"* drove at full throttle, swallowed three artifacts, and
  spent 6.5 of its 8 seconds **parked against the far wall** with exactly three in the hopper —
  which is at the limit and not a violation. It now herds at a third throttle from the bottom
  of the field, which is what the name says.
* *"...with a FULL robot"* never had one: the `clump` helper always emptied the hopper. It now
  takes the hopper as an argument.

### Gotchas worth keeping

* **Get DECODE rule text from `/ftc/archive/2026/game/manual-NN`.** The live `/ftc/game/manual`
  serves the 2026-27 pre-season manual and `manual-11` 404s there. WebFetch's own PDF extractor
  returns binary garbage on these — download and run `pdftotext -layout`, and **without**
  `-layout` for the glossary, whose two columns interleave otherwise.
* **Check every quoted definition against the real glossary.** This rule shipped for months
  against two that do not exist.
* **Do not snap a contact to a face by nearest distance.** The first cut of `contactPush` picked
  the nearest face plane; on a square-ish chassis an artifact dead ahead is exactly equidistant
  from the front face and a flank, and a 1e-11 rounding sent it to the flank — which zeroed the
  push for a robot driving straight at it. The direction now comes from the contact itself.
* **`world.penalties` has no `unslimWorld` backfill.** Nothing was added this session, so
  nothing breaks — but any NEW `PenaltyState` field will be `undefined` on a client talking to
  the older Fly server, and the sim indexes these maps directly. Backfill or read defensively.
  (`ballTrap` was REMOVED, which is safe in both directions: nothing ever read it.)

## Open

* **`BALANCE_VERSION` stays at 4.** It went to 4 yesterday for the push rewrite, and that season
  has only ever existed on the alpha preview, so the standings a second bump would archive are
  empty. G422 and G408 both land inside that same fresh season. Bump it if alpha standings start
  being treated as real.
* Two pre-existing bugs, still unfixed and still not requested: `saveReplay` never stores
  `replay.sim` (so the `SIM_VERSION` gate refuses every DB-served replay — and that gate now
  matters more, since 4 → 5 changes foul totals), and Free Drive with an auto path enabled
  freezes the robot.

---

## 2026-08-24 — robots pushing robots, and what counts as pinning (superseded as READ FIRST)

Branch **alpha**, commit `fd05c68`, pushed. Working tree CLEAN.
`npm test` ALL PASS · `npm run build` green · `npm run server:check` green ·
`npm run test:mm` green. **Deployed to the alpha preview** (`dsim-alpha`), production untouched.

Do not merge to main. Standing rule.

## READ FIRST — where this session ended

An audit of every live path for robot-on-robot pushing found eight defects; all eight are
fixed. `SIM_VERSION` 2 → **3**. **`BALANCE_VERSION` was NOT bumped — that decision is still
open** (see *Open* below). `SIM_VERSION` is now **4** — the pinning rewrite below moved it
again — and the ALPHA PREVIEW is deployed on it.

### The one that mattered: the shove was a mass, and it should have been a force

The sim pushes by **setting velocity**, not by applying force. So the momentum a robot injects
per tick is `collider mass × accel × dt`, and the force it delivers is `mass × accel`. The old
`shoveMass = massLb · pushMult · rpmPush · (1−powerDraw)` was written as if it were the answer
on its own — but `driveParams().accel` already carries `REF_MASS_LB/massLb`,
`REF_DRIVE_RPM/rpm` and `1−powerDraw`. Measured consequences:

| factor | intended | actual before |
|---|---|---|
| `massLb` | push ∝ weight | **cancelled outright** — 20 lb and 42 lb both delivered 5591 |
| `rpmPush` | clamped 2.48× spread | **7.45×**, the clamp defeated by the second application |
| `powerDraw` | ×0.80 at the cap | **×0.64** (squared) |
| `pushMult` | tank:xdrive 4.9× | 12.1×, because `accelMult` rode along |

Verified empirically, not just algebraically: pairs with equal predicted force stalemate, pairs
with unequal force rout. The headline symptom was an inversion — **a 250 rpm minimum-weight
mecanum out-pushed a 42 lb 435 rpm tank**, i.e. the rpm slider was a stronger pushing lever
than the drivetrain pick, which is the opposite of every word in `DRIVETRAIN_PRESETS`.

Now `src/sim/drivetrain.ts` states the force and derives the mass:

```ts
pushForce = massLb · BASE_DRIVE_ACCEL · pushMult · rpmPush · (1 − powerDraw)   // traction-limited
shoveMass = pushForce / (driveParams(spec, tankMode).accel · (1 − powerDraw))  // what delivers it
```

`powerDraw` cancels between the two today. It is written out anyway, on purpose: the identity
must hold whatever `accel` happens to contain. **Never add a term to `pushForce` without
checking whether `accel` already has it.**

**The tradeoff this forces, and why it was taken.** Because `accel ∝ 1/massLb`, `shoveMass`
comes out ∝ massLb². Rapier's one `mass` also decides a ram's momentum split and the positional
split of an overlap, so a 2:1 weight difference now separates ~4:1 there. That is the price of
`accel` staying motor-limited (heavy = sluggish, the point of the mass slider) while push stays
traction-limited (heavy = stronger, which is real). One number cannot be both; it is the pushing
one, because that is what a match turns on. The alternative — dropping `REF_MASS_LB/massLb` from
`accel` — makes both correct at once but removes mass's only downside, and everyone would build
max-mass.

### A shoved robot could not turn AT ALL

Rapier locks robot rotation, so the solve produces no angular response; the only other source
was the heuristic `spin` flick, scaled by the robot's **own** press — zero for anybody who is
not driving. Measured, ramming an idle robot at y-offsets 0/4/8/12 in (the last grazing a corner
of a 16.5 in chassis) left the victim at heading **0.00° and angVel 0.000 every single time**,
while the aggressor yawed 3.5°. Cornering an opponent to spin them is the most basic defensive
move in FTC and it could not happen.

`squareUpPair` now runs the real two-body point impulse — the same model `squareUpStatics`
already used for the gate handle, extended to a second movable body — and takes **only the
rotation** (Rapier owns the linear half; adding it back would bounce apart a pair whose
restitution is deliberately 0). Coulomb `J_t` is in it, which is what makes a flank hit turn you
INTO what you caught. Now: 0 in → 0.00°, 2 in → 4.7°, 4 in → 9.4°, 8 in → 19.1°, 12 in → 27.9°,
and it **settles** rather than running away (checked to 15 s).

### The press was absolute velocity, so contacts carrying no load still torqued

Each robot's press was its own velocity on the normal — a load reading that does not need the
other robot to be there. Two robots cruising side by side in contact, nothing compressed,
squared each other up at 0.45 rad/s; a pair actively **separating** (gap 14.7 → 19.5 in) still
had the trailing one snapped from 11.46° to flush. It is the pair's **closing** velocity now,
shared by both. `contactTorqueDelta`'s "no load, no torque" rule was right all along; the input
was wrong.

### ...and a robot held against a wall by an opponent never squared up

Same root cause on the static side: `pressAlong` reads only the robot's own drive. A 42 lb tank
rammed an idle robot into the field corner and the victim sat at its 22.9° arrival angle for
four seconds. `pressOn` now takes `max(own drive-in, load transmitted through the chassis)`,
with the transmitted part carried from the pair pass in `ContactAcc.ext`. Four tilts (±20°,
±11.5°) all come flush inside 2° now.

### Four more, smaller

- **An auto-path robot was a GHOST.** `solveRobots` skipped body creation entirely for
  `autoPathActive`, so for the whole 30 s of AUTO an opponent drove clean through it (measured:
  end to end, the path robot never moved a thousandth of an inch) and it passed through walls
  too. It gets a **kinematic** body now: solid to everyone, pushed by nobody, path still owns
  the pose. CR never sets the flag, so this is DECODE-only in practice.
- **The pair pass wrote before the statics read.** It rotated both chassis before the walls /
  goal faces / classifier / gate arm worked out their geometry — the exact path-dependence
  `sumTurn` exists to kill, with the robot-robot half left outside it. `ContactAcc` accumulates
  everything and each robot is turned once. Pinned by a check: identical geometry with the robot
  ids permuted now gives bit-identical headings. (Rapier's own body order still follows
  `world.robots`; that is inherent to the solver and stays deterministic.)
- **Penetration.** A max-push tank holding an opponent against the wall buried it ~2.4 in.
  Halving the force fixed most of it; `PHYS_CONTACT_FREQ` 8 → **12** took it to 0.57 in.
- **Dead code.** `collideRobots` and `constrainRobot` (zero call sites) and `CONTACT_BIAS`
  (superseded by `CONTACT_COMPLIANCE`) are gone. `driveSummary()`'s `push` column now prints the
  real force instead of the raw `pushMult`, which had quietly disagreed with the shipped model.

### G422 pinning, read against the manual instead of paraphrased from it

The rule was verified verbatim from the ARCHIVED DECODE manual (Team Update 32, Section 11 V15,
p.112 — note `ftc-resources.../ftc/game/manual` now serves the 2026-27 BIOBUZZ pre-season manual
and `manual-11` 404s; DECODE is only at `/ftc/archive/2026/game/manual-NN`). What it says:

> A ROBOT is PINNING if it is **preventing the movement** of an opponent ROBOT by contact, either
> direct or transitive (such as against a FIELD element) and the opponent ROBOT is **attempting to
> move**. A PIN count ends once any of: **A.** separated by 2 ft for more than 3 seconds, **B.**
> either ROBOT has moved 2 ft from where the PIN initiated for more than 3 seconds, or **C.** the
> PINNING ROBOT gets PINNED. [A and B **pause** the count and it **resumes**.]
> Violation: **MINOR FOUL and an additional MINOR FOUL for every 3 seconds** in which the
> situation is not corrected.

Five divergences, all fixed:

1. **"Preventing" was not tested at all.** Any contact counted. So a robot driving ITSELF into a
   wall fouled whoever was behind it — contact, attempting to move, going nowhere, trapped, and
   the opponent preventing nothing. Measured, the WEAKEST legal build "pinned" a default chassis
   that way. `isPinning` now requires the pinner to lie along the victim's attempted direction
   (`PIN_OBSTRUCT_COS`, ~70° either side).
2. **A tank could not be pinned AT ALL.** "Attempting to move" read `driveX/driveY/rotate`, which
   a Traditional-tank driver on separate sticks never fills — G422 simply did not protect it.
   `attemptDir` decodes the command the way `updateRobot` does, side-drive and field-centric
   included.
3. **The count died on any lapse.** `PIN_BREAK_S` 0.6 s ended a pin outright when the hold
   flickered for any reason, so a pinner could wipe a 2.5 s count by easing off for 0.7 s. Only
   criteria A/B/C end one now, and A/B PAUSE and RESUME — stated twice in the rule.
4. **Criterion C did not exist.** A mutual hold is nobody's foul.
5. **The bill was wrong in both directions.** One MINOR however long you held it, plus a
   MINOR→MAJOR escalation that appears nowhere in G422. It is a MINOR every 3 s now. (G211 lets a
   Head Referee card egregious repeats — judgement, not this rule.)

**`pinnedAgainstWall` is NOT in the rule and is kept anyway.** A FIELD element is offered as an
example ("such as"); direct contact alone can pin. It stays because it is the only thing breaking
the SYMMETRY of a shove, and the cost is small: criterion B ends any pin that travels 2 ft, so the
only open-field pin the rule sustains is a stationary stalemate — and a stationary stalemate is
mutual, which criterion C ends. What is left uncovered is narrow: a robot wedged on another robot
with open field behind it.

**Measured after** (10 s scenes): a static hold bills at 3.05/6.05/9.03 s; a 2 s break pauses and
resumes; a 3.4 s break ends it and the count restarts; a swerve pinner walking the victim 69 in
along the wall bills once and stops (criterion B); a tank victim on side-drive alone now bills
identically to arcade; the drive-into-a-wall scene bills nothing, including against the weakest
legal pinner.

**Test-scene gotcha this exposed:** several pin checks read `w.match.fouls.blue.minor`, which
counts EVERY minor foul blue commits. A pin scene that travels drives through protected zones and
picks up G424/G425 of its own — one probe read 7 "pins" that were 1 pin and 6 zone fouls. Count
G422 events (`pins()` in smoke.ts), and park the artifacts or the pair ploughs a spike-mark pile
along with it and you are testing G408.

### Round two: eight more, found by attacking the fixes

The first pass was reviewed adversarially and the review found real defects in it. Everything
below was introduced (or newly exposed) by the round-one work and is now fixed, with a check
each. Worth knowing that the review's own second pass died on a usage limit with every verifier
agent unrun — its "0 confirmed" was an artifact of missing verdicts, not a clean bill. All seven
of its findings were checked by hand and three were real.

1. **A shoved robot could not turn under its own power.** The pair impulse is recomputed at full
   strength every tick, and for a sustained contact `press` is a constant 8.49 in/s (most of it
   the victim's own braking), giving a permanent −0.7 rad/s that exactly cancelled the wheels'
   +0.6. At full rotate stick a victim managed 87° of a possible 2748 in five seconds; a tank
   managed −13°. The damning part was the sweep: **an x-drive 4.5× WEAKER than its victim held
   it to 103°, the same as a tank 6× stronger.** A torque that ignores how hard it is applied is
   not a torque. `CONTACT_PAIR_SPIN` 0.6 scales the impulse's rotation — the weak pusher now
   holds it to nothing (820°) while an equal or stronger one still pins you. It costs the ram
   (near-corner spin 28° → 17.5°, still clearly offset-graded). The real fix is a contact that
   can SLIP; this is a dial, and it says so.
2. **A moving auto-path robot buried and passed through a bystander.** The kinematic body had no
   linvel, so the solver saw a stationary thing that had teleported 1.56 in — overlap grew to
   15.2in on a 17.5in pair, the SAT min axis flipped, the bystander was ejected sideways, and
   the path robot went through. `world.ts` now sets `r.vel` from the pose delta (which is also
   simply the truth — the HUD, shot-lead and the G422 speed gate were all being told zero).
   Carrying is now perfect: a 1.4in GAP, never touching.
3. **...but a jump is not a sweep.** `initializePathTraversal` teleports the chassis onto the
   path's start point, and dividing that by `dt` gave thousands of in/s that blasted a bystander
   60in. Displacement beyond `maxSpeed × 1.5` reports no velocity at all.
4. **The gate handle wrote straight onto an auto-path robot.** `applyAcc` skips path robots, but
   the gate's point impulse writes `vel`/`heading`/`angVel` directly and bypassed it — newly
   REACHABLE because `pressOn`'s transmitted load gave a non-driving robot a press it never had.
   An opponent ramming a path robot parked on the blue gate handle rotated it 7.4° off the
   heading its path commands, permanently (a `wait` segment never rewrites heading). The whole
   static pass is skipped for a path robot now.
5. **A pair contact VETOED the wall square-up.** `sumTurn` clamps the summed alignment to the
   tightest `flushErr` any contributor reports — right for a static face, wrong for an opponent,
   who will simply slide. Two parallel chassis put the pair's flushErr at ~0, so a robot pinned
   face-to-face had the wall's own −2.86°/tick correction thrown away every tick and sat 18–40°
   off flush. `noVeto()` reports `Infinity` outward while keeping the pair's own capped align.
   The existing pin check could not see it: at exactly π/2 the two normals agree.
6. **A robot crushed between a wall and a kinematic path robot left the step at 959 in/s** — six
   field widths a second. `PHYS_MAX_ROBOT_SPEED` bounds it, applied both on solve write-back and
   at the end of `applyAcc` (the gate impulse adds velocity after the solve).
7. **...and that guard's first form fired in ORDINARY play.** It was `maxSpeed × 2`, scaled to
   the victim's own top speed when what sets a shoved robot's velocity is the PUSHER's. The legal
   envelope runs 30.1 to 120.9 in/s, so the slowest build's ceiling sat BELOW what the fastest
   could legitimately shove it to: 27 of 65 ticks of a plain open-field push were clamped,
   throttling it 12% and putting a discontinuity in the rpm slider with no physical cause. It is
   an absolute 300 in/s now — ~2.5× anything that can exist here.
8. **A robot could be pushed clean out of the field.** No speed guard can see this: Rapier's
   positional correction does not feed velocity, so the victim's `r.vel` read 0.00 for every tick
   it was travelling through the wall. `FieldColliders.bounds` + `outsideBy`/`grewOut` in
   `solveRobots` hold the invariant, and hold it as GROWTH: a robot that began the tick inside
   cannot be pushed out, while one already outside is left alone — DECODE's outflow mouth sits
   at x = −69 and the drain probes park a whole chassis past the wall plane on purpose.
   `PHYS_CONTAIN_SLOP` 0.75in keeps it off ordinary resting penetration (0.57in at the worst
   shove); without that slop the wall square-up lost flush by 1.4° and artifacts began jittering
   against the classifier again — the two-passes-taking-turns failure, exactly as advertised.

**Also from round one, and worth keeping in mind:** two REAL findings were pre-existing and are
NOT fixed here — (a) Free Drive with an auto path enabled freezes the robot completely
(`world.ts` runs path traversal only in `auto` but skips `updateRobot` whenever `autoPathActive`,
and `free` never reaches `auto`); (b) `server/db/repo.ts` `saveReplay` never stores
`replay.sim`, so the `SIM_VERSION` gate refuses every DB-served replay. (b) matters more now that
`SIM_VERSION` moved.

### The stiffness sweep, so nobody re-litigates it

`PHYS_CONTACT_FREQ` was 8 Hz on the reasoning that SOFT contacts let a body starting deep inside
a wall bleed out instead of being ejected. Swept 8/15/20/25/30/40/60 Hz against both hazard
cases (a robot seeded 2 in inside a wall; two robots seeded 6 in overlapped): **recovery velocity
was 0.0 in/s at every single setting** — Rapier's positional correction here does not feed
velocity, so there is no explosion to buy off. Penetration under a max shove: 1.22 in at 8 Hz,
0.59 at 12, 0.55 at 15, 0.49 at 25, then it creeps back up. **12 was chosen, not 25**, because
15 Hz broke the classifier-jitter ratchet and 25 Hz also broke two G408 possession checks and
the wall-ram torque bound. 12 is the largest step with zero collateral.

### Test coverage

`npm test` gained ~20 checks and lost nothing. The three that changed MEANING:

- `heavier robot yields less (42 vs 21 lb ≈ 1:2 push)` → `(42 vs 21 lb, by shove mass)`, ratio
  now >2 rather than ≈2. It seeds two robots OVERLAPPING at rest and steps ONCE, which measures
  the solver's positional split — **not** a pushing match. That is exactly why the double-counts
  survived so long: under this test 20 lb and 42 lb looked 1:2 apart while delivering identical
  force. The real coverage is the new `pushContest()` helper (both robots driving, 3 s).
- `geared-for-speed (600 rpm) robot yields more than a torquey (300 rpm) one` — deleted and
  replaced by a driven contest. Shove mass is rpm-INDEPENDENT inside the clamp band now
  (`rpmPush · rpm = 435`), so the seeded-overlap version could not express it; the force is not,
  and the driven version rules on it decisively.
- `chain endgame: ascended a ring stand` placed the robot at `ringStands()[3]`, i.e. **inside**
  the solid post — the thing `CHAIN_START_POSES`' own comment says the stand anchors exist to
  avoid. It only ever passed because the contact was soft enough that 0.1 s of ejection stayed
  under `endgameOf`'s 12 in/s gate. It uses the anchor now.

## Open

- **`BALANCE_VERSION` 3 → 4 — DECIDED, a fresh ranked season.** Every head-to-head outcome
  moves and the stiffer contact moves solo record scores too, so the current DECODE and Chain
  Reaction standings are archived and the boards start over. `SIM_VERSION` 2 → 3 handles replay
  invalidation on its own axis.
- **DEPLOYED to the ALPHA PREVIEW** — `./scripts/fly-deploy.sh --alpha` → `dsim-alpha`, image
  `deployment-01M0V3KPC6YEPRQ9JBH2B2Q3KW`, one machine in `iad`, `/health` returns `ok`. Its own
  database, no live players. (It reports `stopped` between requests; the preview auto-stops when
  idle and Fly starts it on the first connection — that is normal for the single-region app.)
- ⚠️ **Production `dohun-sim-decode` is still on the OLD physics.** A production client built
  from this branch would predict the new sim against a server stepping the old one — constant
  reconcile snap-back. Ship it with `ADMIN_SECRET=… scripts/announce-deploy.sh` when the season
  reset is wanted for real; that is a separate decision from this preview.
- Gotcha for next time: the `flyctl` token in `~/.fly/config.yml` had expired (well-formed
  `fm2_` macaroon, `last_login` six weeks earlier), and flyctl reports that as
  *"no access token available"* rather than a 401 — it reads as a missing credential, not a
  stale one. `flyctl auth login` is the fix.
- The **residual order-dependence is Rapier's own body order** (`world.robots` order), not the
  bespoke pass. It is deterministic and identical for identical inputs; it only shows if you
  permute which robot holds which id, which never happens in a real match.
- CR's **ring-stand colliders still get no contact-torque square-up** — `squareUpRobotsWalls`
  aligns to the four perimeter walls only. Out of scope here; worth a look if a robot leaning on
  a stand feels wrong.

## Gotchas earned here

- **Probe worlds are full of field geometry.** A "two robots travelling together" check placed at
  x=−60 has both chassis reaching past x=−66 into the classifier channel, and one catching it and
  the other not IS relative motion — the check failed for a real reason that had nothing to do
  with what it was testing. Stay mid-field, and park the artifacts
  (`state = { kind: 'held', robot: 99 }`).
- **`flywheelInertia: 0` for any two-robot symmetry check.** The flywheel's power draw ramps with
  distance to your own goal, so two robots at different positions otherwise have different accels
  — real relative motion that will be mistaken for a contact bug.
- **`PHYS_SOLVER_ITERS` is SHARED with the ball world** (`makeWorld` takes freq/error as
  parameters but not iterations). Raising it 8 → 12 moved two artifact-possession checks; the
  robot-only levers are freq and allowed-error.

## (older) HANDOFF — 2026-08-22 (contact geometry: the closest FEATURE, and one turn per tick) — alpha only

Branch **alpha**, commit `fb75a83`. Working tree **CLEAN**. `npm test` ALL PASS ·
`npm run build` green · `npm run server:check` green. **Not deployed.**

Do not merge to main. Standing rule.

**MERGED IN (this session):** `df4b085` *hosted name moderation* off the long-lived
`moderation` branch. Server is the authority for every user-supplied NAME (username,
display handle, robot/team names on the public leaderboard + live roster) via
`server/moderation.ts` — a HOSTED endpoint (default OpenAI's free `/v1/moderations`),
NOT a hand-rolled wordlist (the user rejected that; a deleted `nameFilter.ts` — do not
resurrect it). Env-gated on `MODERATION_API_KEY` like `DATABASE_URL` gates records:
absent ⇒ disabled, every name allowed, ZERO network. FAILS OPEN on outage/timeout;
`/admin` forced-rename is the human backstop.
**DEPLOY:** this is a SERVER change — `./scripts/fly-deploy.sh` (NEVER a bare
`flyctl deploy`) AND `fly secrets set MODERATION_API_KEY='sk-…' -a dohun-sim-decode`.
Backward-compatible: no key ⇒ no-op, and the `reason:'inappropriate'` field is additive
so old clients ignore it. No CSS/colour change (reused `--ds-danger`).

### (older) Where that session ended

*"Collision with the gate/corner of the gate is still very weird."* Three structural
things, all in `src/sim/physics.ts`:

1. **The normal at a corner.** The gate handle and the classifier both took their normal
   from SAT's least-overlap axis (the handle, from a snap to whichever axis the centre was
   furthest along). Both treat a rectangle as all FACE, so near a corner the normal jumps
   between axes as the robot crosses the diagonal — the push direction, and which way you
   are turned, flips within a fraction of an inch. Now: clamp the centre onto the rect; one
   coordinate moved is a face, both moved is a CORNER and the normal runs from it.
   Continuous everywhere.
2. **Surfaces are summed, then the chassis turns once.** Each surface used to write
   `heading` as it was processed, so the gate arm computed its geometry against a robot the
   classifier had already rotated. `contactTorqueDelta` is pure, `squareUpStatics` sums, and
   the flush cap that survives is the tightest any FACE imposes.
3. **The arm's manifold is both bodies' features**, unioned, not three fallbacks in priority
   order (which one answered depended on which side you hit from).

**Measured** (drive into the arm, 2in steps across it): centred 0 deg; off-centre from the
tunnel side 7/7/7/11 deg; from the channel side 0-15 depending on where you meet it. The
channel-side spread is **not** a discontinuity — instrumented, one surface acts there and
contributes a steady 0.19 deg/tick — it is how far the chassis turns before it slides off a
2.5in stub. Bounded by a smoke check that prints both sides.

### Still open here

- **The response is a heuristic, not tau = sum(r x F) / I.** A full physical rewrite was
  tried and REVERTED this session: 20 deg hits were perfect, small angles rocked +/-9 deg,
  10 checks red. Findings kept: mass cancels; the impulse denominator is
  `1 + (r x n)^2 / (I/m)` with `I/m = (l^2 + w^2)/12`; `press` reads as a FORCE, not an
  impulse; and the torque must turn the CHASSIS, not integrate `angVel`.
- One squeeze still rings: an artifact between a driving intake and two walls, 1.48in at
  4/s. Bounded, not gone.

### Two traps that cost real time this session

- **Heading wrap.** Raw `heading` deltas read as full 360 turns. Three separate "it spins me
  round" diagnoses were my own probes, not the sim. Unwrap, or measure mod 90.
- **Parking probe artifacts at (300,300) does not remove them** — the ground clamp snaps
  them back into the field, and the robot then pivots on a pinned ball. Use
  `state = { kind: 'held', robot: 99 }`.

## (older) HANDOFF — 2026-08-18 (the ramp: a stalled column, and the overflow lane) — alpha only

Branch **alpha**, commit `3aa4697`. Working tree **CLEAN**. `npm test` ALL PASS ·
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

### Four more from play, and one question left open

**A robot has a TOP** (`6f10fb5`). *"If an artifact lands on top of the robot and I move away,
they jolt."* The intake got a roof earlier; the CHASSIS did not, so an artifact coming down on
one fell into it and was ejected out the nearest FACE — measured, dropped on the middle of an
18in chassis it moved **9.8in sideways in ONE tick** and was then shovelled along to 76 in/s.
`robotTopZ` is the top (roller structure over the intake, robot height over the chassis). The
throw was also floored against the artifact's WORLD velocity, which says the roof is the field;
flooring the RELATIVE velocity makes it an artifact on a moving surface, so nothing steps when
the roof runs out. `ROBOT_TOP_SHED` walks it off the side it landed nearest — a FLOOR, never an
addition (adding per tick is 360 in/s² dressed as a nudge). Shots are unaffected: a robot
anywhere in the lane still lets 3 of 3 through.

**Overflow rides the column** (`c147af5`). *"They ride on top of the balls already in the
classifier, so it would move kinda like in steps, and it would get extra momentum from the
balls if the gate is open."* The rider had no idea what it was on — it took the RAMP's gravity
less a rolling loss and arrived faster than the column it was riding. `OVERFLOW_CARRY` is
rolling contact: its speed is dragged toward the speed of the artifact beneath it. Shut gate ⇒
stationary column ⇒ dragged to a crawl, and only the small leftover pull walks it over the
crests (the stepping). Open gate ⇒ the column's momentum is handed to it. `OVERFLOW_ROLL_LOSS`
0.36 → 0.88 of RAIL_ACCEL and `OVERFLOW_BUMP` 0.48 → 0.10 set that leftover. **0.0in of travel
in 2s shut, 10.2in open.** Three checks had to be told which case they ask about.

**Jitter** (`6de591c`). Swept the contact situations where it hides, measuring reversals/s on
anything with under 2in of net movement and visible amplitude. **Robots are clean everywhere.**
Artifacts were not, and the cause was correction SIZE: separation took out an overlap entirely
in one pass, which overshoots whenever another constraint disagrees — against a wall, always.
`BALL_SEPARATION_RELAX` (half per pass, `BALL_RELAX_PASSES` 4 → 6) plus `BALL_SETTLE_SLOP` (a
resting artifact away from robots that ends the tick within 0.2in of where it started, ends it
there). Six of seven scenes clean at 0.8/s.

⚠️ **STILL OPEN**: an artifact squeezed between a driving robot's INTAKE and two walls rings at
1.48in, 4 reversals/s (down from 15). Three narrower fixes all made something else worse and
are recorded in the check: extending the jam rule to any solid part of the robot let artifacts
through a corner gap they cannot fit; rate-limiting the eviction took it to 25/s; reverting
resting artifacts near a robot lets a robot creep through one. Bounded so it cannot regress.

### The gate torque, answered — and the square-up bug it uncovered (`b422a7e`)

*"The intake is part of the contact area."* That settled it, and wiring it up turned out to
depend on a second, larger bug.

**The intake is contact area.** Every contact test in `squareUpStatics` was built from
`robotCorners` — the CHASSIS — and the gate is pressed with the INTAKE: the chassis's
front-most corner stops half an inch short of the stub the robot leans on. The handle now
reads the FOOTPRINT (`footprintCornersOf`, `footprintMTV`), grown by the touch epsilon because
Rapier leaves a hair of separation and a strict overlap test fires never. Where a robot's front
EDGE rests on the 2.5in stub with no corner in it, the contact is the stub's own corner digging
into that edge — the nearest point ON the stub sits dead ahead of the robot's centre, where the
lever arm is zero and the torque with it, which is why the first attempt measured identical to
having no code at all.

**And the bug that made it look like a trade-off.** *"Even when I ram with the back of the
chassis where there is no intake, the robot only turns if I impact it at certain specific
angles, weird."* The classifier passed `contacts.length > 1` as its square-to flag, so a
single-corner press took `applyContactTorque`'s PIVOT mode — which has no flush cap and spins
instead of settling. A flat face aligns a chassis whether one corner is on it or two; the walls
have always passed `true`. **Across ten approach angles, front and back, the classifier now ends
0.0° off flush at every one.**

With that fixed the gate torque costs nothing: the tap benchmark is back to **worst 6 / best 9**
and GATE INTAKING drains **9 of 9** with the hopper full — they were 4 and 1 when the torque was
first tried against the pivoting classifier. So the "arm can push you straight OR you can gate
intake" trade-off recorded in the previous handoff entry was an artifact of the pivot bug, not
a real choice.

⚠️ The 360° turns this first appeared as were a MEASUREMENT artifact: the sim wraps the heading,
so a raw delta reads as a full turn. Measure the remaining tilt mod 90 instead — the check does.

### The gate torque, actually applied — and the SAT normal that hid it (`73b3ac7`)

*"Still no torque being applied at gate."* The contacts were being found: torque 0.26, press
5.9, and the heading did not move a hundredth of a degree in four seconds.

**The reason is the NORMAL.** SAT returns whichever of its four candidate axes overlaps least,
and two of those are the ROBOT'S OWN. When it picks one, the normal comes back aligned with the
chassis — and `applyContactTorque` measures "how far from flush" against that normal, so the
answer is **zero by construction**. The stub is axis-aligned, so its face normal is the axis
from its centre to the robot's, snapped to the dominant component. Pressing the gate at ten
tilts from −20° to +20°: **every one ends 0° off flush**, where before nothing under 12° moved.

Each contact also carries its **own depth** now. Handing both stub corners `mtv.depth` makes
them symmetric about a robot pressing square-on, the cross products cancel, and the torque is
zero — which is why it only ever turned at big tilts, where one corner falls outside the band
and stops cancelling the other.

**Worth remembering generally:** a torque built on a SAT normal is measuring against a
direction that may be the robot's own. Any future contact-torque surface needs the STRUCTURE's
normal, like the walls have always used.

### A pile outside the gate no longer throttles the ramp (`73b3ac7`)

*"Ball flow gets slowed down if there are balls right outside the gate. Don't let it slow
down."* The doorway artifact was part of `canLeave`, so what was already on the floor gated the
discharge:

| artifacts piled outside | 0 | 6 | 10 | 14 |
|---|---|---|---|---|
| nine out, before | 1.65s | 1.88s | 2.07s | **2.20s** |
| after | 1.47s | 1.48s | 1.48s | **1.48s** |

A chute does not ask the heap whether it may discharge — what comes out shoves what is there,
which is what the exit nudge is for. The mouth is clear unless a ROBOT is across it. **The
invariant that mattered is untouched**: the solver and the release still agree about what stops
the column (the robot, and nothing else), so nothing can descend past an exit that then refuses
it.

### One check changed MEANING, not value

Pressed hard on the lever at 19° — the pose reported verbatim from play — the arm now squares
the robot to 0° and its mouth lands over the drop point, where the drop-space rule holds the
ramp. Backing off enough to clear the drop point also stops holding the lever (gatePos 0.22 at
2in back, 0.00 at 4in). **That is two requested rules meeting, not a regression**, and the
check says so at length rather than being deleted. Gate intaking itself is alive: the other
gate-intaking check drains **9 of 9 at a 0.119s mean gap**.

### ...at the arm's pace, not the field's (`ec806b8`)

*"The gate applies way too much torque way too fast."* Measured: **20° off flush to square in
167ms**, which is a whip, not a lever.

The rate was the WALL's. A wall is the field and may square a chassis as fast as it likes; the
handle is a 2.5in hinged bar. `GATE_ARM_TORQUE_MULT` was scaling the PRESS term — which only
feeds the pressure gain and barely moved the result — and now scales the RATE, which is the
thing that was wrong. Direction and the flush cap are geometry and are untouched. At **0.12**,
20° comes square in **1.25s**: a firm nudge you can drive against.

Two checks moved to the measured behaviour rather than around it:

- the arm holds contact for a second and a half while it turns you, over which the chassis
  settles **1.30in** further out as the rotation resolves. That is the rotation, not a shove —
  the shove that check was written for was 3.85in — so its bound went 1.0 → 1.5.
- the 19° GATE INTAKING pose discharges into the angle it still has while the arm works on it,
  so **one** artifact gets out before the mouth closes over the drop point. What must not
  happen is the ramp emptying, and that is what it asserts now.

### A contact squares you up; it does not snap you round (`bfa0a26`)

*"It is still WAY too fast. It spins me around like 90 degrees instantly."* Two things were
doing it and **neither was the gate**:

- **The align ceiling.** `CONTACT_PRESS_GAIN` scales the align rate with how hard you press, up
  to `CONTACT_ALIGN_RATE_MAX` — which was 0.12 rad, **6.9° in ONE TICK, 412 deg/s**. A firm
  press quadrupled the base rate into a snap, on every structure in the game. At **0.05** the
  worst single tick ramming a wall at speed is 2.9° (174 deg/s) — about what a robot turns
  itself — and 20° still comes flush in well under a second.
- **The flick.** `CONTACT_IMPACT_SPIN` adds angular VELOCITY on a fast angled hit and, unlike
  the alignment, is NOT capped at the remaining tilt — it keeps turning the chassis after the
  contact is done. Wall ram peak spin **3.23 → 0.80 rad/s**.

It was also not scaled by the surface's rate multiplier, so slowing the gate arm's alignment
left its flick at the field's rate — the one part of the arm that could still whip you was the
only part still running full strength.

*"If I hit with the gate opener the robot doesn't turn, if I hit with the intake it turns
insanely fast"* — both halves gone: hitting the arm at five offsets across the mouth turns
17–20° and ends flush, worst single tick 3.2°.

The classifier grind-jitter bound went 15 → 20 jump-frames, which its own note anticipates
("legitimately shifts when contact tuning changes") — a robot that squares up more slowly
grinds at an angle for longer. Worst single jump unchanged at 2.45in against a 2.5in bound.

### The wrong-way turning: analysed, and it was the load sharing (`2de7310`)

*"It's turning me the other way sometimes. Fundamentals. Analyse."*

**One line.** The contact list is every corner within `CONTACT_TOUCH_EPS` (half an inch) of the
surface, and the load was shared as `depth + CONTACT_BIAS`. **That floor is a vote for corners
that are not touching.**

It reverses the torque because the two front corners are NOT mirror images — the intake extends
the front, so a tilted chassis presents corners with different lever arms. Measured at 3° off
square against a wall: the bearing corner's lever is **7.70**, the corner half an inch clear is
**8.78**. Weighted 0.6 and 0.2 by the floor, the fabricated vote takes 40% of a longer arm, and
past some tilt the sum points the wrong way. *Sometimes.*

`CONTACT_COMPLIANCE` replaces the floor: bumpers squash, so the share is how far each corner is
compressed relative to the deepest — full load there, nothing beyond half an inch of it. A
corner that is not touching carries no load, which is not a modelling choice. Square on, the
bearing corners compress equally, the moments cancel, and the robot settles — the same
equilibrium, now for a reason.

| approach | result |
|---|---|
| wall, every tilt −6°…+12° | **0.0° off flush** |
| gate, every tilt −12°…+12° | **0.0° off flush** |
| gate, hit 5in off centre with one side | **0.0° off flush** |

**The gate cases are the ones that used to do nothing at all**, and it was the same bug: its
contact set is the STUB's two corners, symmetric about the robot's centre line, and the floor
weighted them so evenly they cancelled to a torque of **0.003** — "no torque at the gate" —
while a hair more tilt let one escape the band and it snapped. Both complaints, one cause.

### ⚠️ The response is STILL a heuristic — the physical model, measured, not yet in

Separate from the above, and still true: `applyContactTorque` scales a "torque" by a tuned
gain, caps it at a tuned ceiling, WRITES the heading, and clamps against a mod-90 target. The
physical model was built this session and reverted; keep these findings:

    tau = sum r_i x F_i ;  alpha = tau / I ,  I/m = (l^2+w^2)/12 ;  |j_t| <= mu*j_n

1. **Mass cancels** — impulse `m·press`, inertia `m·(l²+w²)/12`. How far a hit turns you is the
   geometry of the hit, not your weight.
2. **The impulse that stops the CONTACT POINT** is `m·v_n/(1 + (r×n)²/(I/m))`; without the
   `moment²` term a 40 in/s ram peaked at 9.6 rad/s.
3. **`press` is a force reading, not an impulse** — a robot held at a wall reads 22 in/s of
   approach every tick, i.e. 3.4 g sustained. It must be `(postVel − preVel)·n̂`.
4. **The torque must turn the CHASSIS, not `angVel`** — `updateRobot` servos `angVel` to the
   commanded yaw, so the two cancel.

With 2+3 fixed a 20° wall hit squares perfectly. It was reverted because small angles rock:
the eps-banded list picks ONE corner, a firm impact rotates 4.6° against a 3° error, the far
corner takes over, ±9°. **The fix is the contact SET, not the response** — both corners with
true signed depths, a proper 2-point solve. The compression weighting above is the first half
of exactly that.

### The ramp has a delivery speed, and a hard hit is an impulse (`52ac706`, `19ee488`)

**"The balls get supercharged and dash down if I gate intake — since the torque change."** It
was: the same commit stopped the pile outside the gate throttling the discharge, and with
nothing taking anything back the last artifacts off a full column ran all 59in of ramp
unopposed and left at **69 in/s**.

`RAIL_ACCEL`'s note is right that ROLLING resistance does not grow with speed — but rolling is
not all that happens. The channel is a 6in groove around a 5in artifact, so it weaves down it
(`railWander`), and the faster it goes the harder it works the walls. **That** loss grows with
speed, and it is what gives a chute a delivery speed. `RAIL_RATTLE_DRAG` 1.1/s puts it at
`RAIL_ACCEL/1.1` ≈ 45 in/s.

| | before | after |
|---|---|---|
| exits off a full column | 24..**69** in/s | 20..**39** in/s |
| first artifact out | 0.53s | **0.53s** (untouched) |
| all nine clear | 1.9s | 1.9s |

The START is untouched because it is a DRAG, not a cap — an artifact at rest has no speed for
it to take. An ELEVATED artifact is exempt: it rides the column, not the channel.
`GATE_KNOCK` 0.05 → **0.085**, because a slower flow hands the arm less momentum and the tap
benchmark fell to a worst of 3; at 0.085 it is worst 6, best 9, mean 8.8.

**"Even if I hit it with a large impact it doesn't turn me."** The impulse a collision hands
the chassis lived inside an `else if (flushErr > 0.05)` — so arriving fast and nearly straight,
the case where a hit is most obvious, produced nothing. It is its own term now, with two
guards that are both the alignment cap's own argument (*a surface cannot turn a robot into
itself*): the ALIGNMENT may only reduce the tilt, and the IMPULSE is guarded against the TILT
rather than against `align` — comparing it to `align` passes trivially whenever `align` has
been zeroed for pointing the wrong way, which is exactly when it is needed.

Run-up rams at −20, −8, −3, +3, +8, +20° now all end **0.0° off flush**, wall and gate. Worst
single tick 3.0°, peak spin ~1 rad/s.

⚠️ **Tried and reverted within the hour**: reading `press` as the momentum the solve actually
removed, rather than the approach the drive is holding. It is the better measure of an IMPACT,
and it is **zero exactly when the settling torque is needed** — a robot already resting on a
wall has no approach left to take — so a robot leaning at an angle just stayed there. The note
in `pressAlong` records it.

⚠️ **A probe hazard worth remembering**: parking artifacts "out of play" at (300,300) does not
work — the ground clamp snaps them back inside the field, often right where the robot under
test is about to ram. Two wrong-way diagnoses this session were pinned artifacts, not the
surface. Set them `held` instead.

### The gate handle is a POINT, so it pivots you (`fea5c1a`)

*"When I hit the gate with the leftmost or rightmost side of the robot, I should be turning but
I square up instead."*

Every other surface in the square-up pass is a **face** — wall, goal face, classifier side — and
a chassis pressed on one bears on two corners whose moments cancel when it is flat against it.
Flush is where it settles; that is why they pass `squareTo = true`. **The gate handle is 2.5in
of bar.** Nothing about it can align an 18in chassis, and asking it to was the bug.

A point contact has an equilibrium of its own and needs no cap to find it: the moment is
`r × n`, which vanishes when the contact comes to lie on the line through the robot's centre
along the push. Lean on the arm off-centre and you turn about it until it is dead ahead;
arrive centred on it and you are not turned at all.

| arm off the robot's centre line | 0in | 3in | 6in | 8in |
|---|---|---|---|---|
| turn | **0°** | 24° | 57° | 57° |

**This is the general rule the pass was missing**: ask a FACE about flush, ask a POINT about its
moment arm. Two checks were asking the gate about flush and are now one check about the pivot;
a third pinned a blocking robot's position but not its heading, and an unpinned robot now
pivots off the arm and stops blocking the outflow it was put there to block.

### No load, no torque (`3aa4697`)

*"Torque is being applied with me not doing anything."*

The response's gain was `1 + press * CONTACT_PRESS_GAIN`. **That floor of 1 means the geometric
torque alone rotates a chassis at ZERO press** — touch a surface and it turns you, with nothing
pushing.

Against a FACE it hides: the flush cap stops the rotation the moment the robot is square, so it
reads as settling. Against the gate handle it does not hide at all, because a point contact has
no flush to stop at. Measured: a robot **parked beside the arm and never given a command turned
359.6°** on its own; one that had driven in and let go turned another 35°.

The gain is `press * CONTACT_PRESS_GAIN` now, and zero press returns before anything is
written. Worst idle turn over four resting poses (parked at the gate, driven into the gate and
released, the same at a wall and at the classifier): **0.0°**.

**The GATE INTAKING pose has been through three states this session** and the current one is
the physical one — the check says so at length rather than being re-tuned:

| | ramp discharge |
|---|---|
| arm applied no torque, robot held 19° | 9 of 9 |
| arm SQUARED the robot → mouth over the drop point | **0 of 9** |
| arm PIVOTS (it is a stub, not a face) → robot keeps its angle | 4 of 9, hopper filling |

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
