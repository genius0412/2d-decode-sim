# HANDOFF — 2026-07-25 (desktop = thin shell over the live site + baked env) — READ FIRST

## This session — downloaded app now (a) auto-updates content by loading the live site and (b) can actually play online

Two fixes to the Electron desktop build, no sim/web-UI changes:

1. **Thin-shell load model** (`electron/main.cjs`). `createWindow` no longer `loadFile`s
   the bundled `dist` unconditionally. New `loadApp(win)`: a fast `siteReachable()` HEAD
   probe of `https://www.playdsim.com/version.json` (2.5 s timeout, dead host fails in
   ~11 ms) decides — **online → `loadURL(SITE)`** (the app is always the current Vercel
   deploy, so game content updates with every web deploy, no re-download), **offline →
   `loadLocal(win)`** (the bundled copy; the common case for a downloaded build). A
   `loadURL().catch` (ignoring benign `ERR_ABORTED`) is the safety net → falls back to
   local if a reachable-but-failing load happens. Added `setWindowOpenHandler` → external
   browser for `target=_blank`/`window.open` (all the app's external links use `_blank`).
   **Deliberately NO `will-navigate` guard** — Google `signIn.social` is a full-page
   redirect to the provider and back; blocking it would break in-app auth.

2. **Baked public env into the desktop bundle** (`vite.config.ts`). The Electron build gets
   NO Vercel env injection, so the old bundled build shipped with `VITE_GAME_SERVERS`/
   `VITE_NEON_AUTH_URL` ABSENT → `SERVERS=[]` → multiplayer hidden, auth off (the bug the
   user hit: "downloaded apps can't play online"). Now, behind an `if (process.env.ELECTRON
   === '1')` guard, vite sets those two vars (the EXACT public values already in the deployed
   web bundle — extracted from the live JS; nothing secret) via `process.env.X ??= …` so an
   explicit override still wins. **The web build (ELECTRON unset) is provably untouched** —
   hard `if` gate; Vercel keeps supplying its own env. `.env.*` is gitignored so a committed
   dotenv would never reach CI — hence baking in vite.config, the single source that covers
   both CI (`release.yml` runs `npm run build` with `ELECTRON=1`) and local `npm run dist`.

**Verified** (real Electron drive, temp drivers deleted): online load → URL
`https://www.playdsim.com/decode`, `window.dsim` bridge present, real app renders. Offline
fallback → `file://…/dist/index.html` renders, and its menu shows live **"online · 3 signed
in"**, **525 PLAYERS / 8,396 GAMES PLAYED**, solo/duo/1v1/2v2 counts — i.e. the bundle now
reaches the game server + auth. Bundle grep confirms all 5 regions + the neon-auth URL baked
in. `ELECTRON=1 npm run build` green (tsc strict + vite). No new release cut yet — this ships
in the next tagged desktop build; existing v0.1.2 web/proxy/update flow unchanged.

**Follow-up (not done):** true auto-INSTALL (electron-updater) still needs code-signing
(Apple $99/yr is the hard gate; Windows unsigned works with SmartScreen warnings; Linux
AppImage free). The thin-shell model above makes CONTENT updates instant regardless, so a
shell rebuild is only needed for Electron/native changes. In-app Google sign-in may still hit
Google's `disallowed_useragent` block in the Electron webview (email/password unaffected) —
untested in-app; the existing `isEmbeddedBrowser` guidance applies.

---

# HANDOFF — 2026-07-22 ("Play a friend" format picker) — READ FIRST

## This session (latest) — the deferred "Play a friend" mode-picker (client-only)

Built the "Play a friend" format picker the 2026-07-21 handoff deferred (its TODO +
feasibility map is below, still accurate). **Client-only — rides entirely on existing
pipes, NO server/DB/protocol change** (the deployed server already accepts
`record`/`duo` room invites via `inviteToRoom`), so Vercel auto-deploys. `npm run build`
green, `npm run contrast` 167 (unchanged — new CSS reuses audited token pairs), menu
shell boot-verified in Electron (no render crash from the new provider child).

**What it does:** clicking **Challenge** on a friend (panel row, profile, or toast source)
now opens a modal FORMAT picker instead of instantly hosting a 1v1 versus room. Tiles:
- **1v1 · Casual** and **2v2 · Team up** → a custom `versus` room (the 1v1-vs-2v2 split is
  emergent — a versus room admits up to 4; you sort alliances/add drivers in the lobby).
- **2v0 · Co-op record** → a `record`/`duo` co-op run.
- **1v1 · Rated** and **2v2 · Ranked** → shown DISABLED ("Soon"): rating is only applied
  to matchmaker-staged rooms and there's no premade/party concept yet (see feasibility map
  below — these need server work, deliberately not faked).

**How it's wired:**
- `src/ui/ChallengePicker.tsx` (NEW) — the modal + `ChallengeFormat` type
  (`'casual1v1' | 'casual2v2' | 'duorecord'`). Reuses `.ds-modal-backdrop`/`.ds-modal` +
  `.ds-opt` tiles. Success navigates away (unmounts the modal); only a failed invite lands
  back with an inline error + re-enabled tiles.
- `src/ui/friendsContext.tsx` — `challenge` now takes `(username, format)` and maps
  `duorecord`→`inviteToRoom(...,'record','duo')` else `versus`. New `openChallenge(username)`
  opens the picker (provider owns `challengeTarget` state + renders `<ChallengePicker>` once,
  so panel/profile/anywhere just call it). `onHostRoom` gained a `kind: RoomKind` arg.
- `src/ui/App.tsx` — `hostForChallenge(code, game, kind)` routes `record`→`duorecord`
  screen, else `lobby` (mirrors `onJoinInvite`'s recipient routing, already correct).
- `src/ui/FriendsPanel.tsx` / `ProfileFriendActions.tsx` — Challenge buttons call
  `friends.openChallenge(username)` (was `challenge`); `ChallengeButton` lost its busy state
  (opening the modal is synchronous now).
- `src/ui/shell.css` — `.ds-chal*` (modal width, tile list) + `.ds-opt:disabled` neutralised
  hover + `.oz.soon` muted badge.

**Recipient path was already complete** — a `record` invite's toast/panel "Join" routes to
`duorecord` via the existing `onJoinInvite`. **Not verified:** live two-account
send/receive/host for each format (needs live accounts — same limitation as all friends work).
Left open (needs server work, per the feasibility map): 1v1 rated + 2v2 ranked-with-friend.

---

# HANDOFF — 2026-07-21c (Google sign-in in-app-browser guard)

## This session — fix Google OAuth `disallowed_useragent` in in-app browsers (client-only)

User hit Google's **`Error 403: disallowed_useragent`** ("Access blocked … Use secure
browsers") on mobile but not desktop. Cause: opening the sim link from inside a social
app (LinkedIn/Instagram/…) runs the page in an embedded WEBVIEW, and Google refuses OAuth
there. Not a Neon Auth misconfig — Google can't be made to allow embedded webviews.

Fix: `src/lib/browserEnv.ts` `isEmbeddedBrowser()` (UA sniff — named in-app tokens +
Android `wv` + iOS non-Safari WKWebView). In `AuthPanel.tsx`, when embedded the "Continue
with Google" button is replaced by a hint ("open in Safari/Chrome — or use email above") +
a **Copy link** button. Email/password sign-in is unaffected and always shown. Conservative:
a false positive only downgrades the Google button; a false negative just re-shows Google's
block screen. Client-only → Vercel auto-deploys, no server change. `npm run build` green.
Possible follow-up: Android `intent://` escape to Chrome; verify the UA heuristic against a
real LinkedIn in-app browser.

**Also fixed (Chain Reaction):** the `▲ ASCENDED` / `■ PARKED` endgame badge over robots
was drawn upside down in match views. `src/games/chain/draw.ts` counter-rotated by `+up`
(= `+viewAngle`); with ±90° driver views that rotates the glyphs 180°. Changed to `-up` to
match the DECODE label path (`renderer.ts` rotates `-viewAngle`). Build green.

---

# HANDOFF — 2026-07-21b (matchmaking reliability: ghost-socket reaper + fair-host fallback)

## This session (latest) — two matchmaking bug fixes (server/index.ts only)

User reported: (1) queue "often says 4/4 or 5/4 but the match doesn't start"; (2) "the
game server is usually one-sided, not meeting in the middle." Diagnosed + fixed both in
`server/index.ts`. Server-only change — **needs a deploy to take effect** (`fly-deploy.sh`).
server:check + `npm test` green.

1. **Ghost-socket reaper (fixes "4/4 won't start").** There was NO WS-level keepalive — a
   half-open TCP connection (laptop sleep, wifi drop, hard-killed tab) never fires `close`
   until the OS timeout (minutes+). Until then the socket is a GHOST: it stays in the ranked
   QUEUE (bucket reads "4/4"/"5/4" but a match staged against it never completes) and holds
   its room slot. Added a `socketAlive` WeakMap + `ws.on('pong')` + a 15s `ws.ping()`/
   `terminate()` heartbeat interval (bottom of file). A reaped socket fires the normal
   `close` teardown (`matchmaker.remove` + `room.detach`). Browsers auto-pong at the protocol
   level, so only genuinely-dead sockets are reaped. (The pre-existing `pong` at the msg
   handler is an APP-level RTT reply for the NetQuality HUD — unrelated.)
2. **Server-observed home region (fixes one-sided host).** The client's `homeRegion` comes
   from a `/health` `x-region` probe (`src/net/ping.ts`); a cold/auto-stopped satellite makes
   Anycast fall back to the warm primary (or the probe returns `''`), so the server defaulted
   the player to `REGION` (iad) → minimax `bestHost` hosts every such match at iad → one-sided.
   Added `replaySrcRegion(req)` which reads Fly's `fly-replay-src` header on the replayed
   `?mm=1` connection (Anycast lands it on the client's NEAREST region, which replays to the
   matchmaker → server-authoritative nearest region). Used ONLY as a fallback:
   `homeRegion: msg.homeRegion || edgeRegion || REGION`, so the working probe path is
   unchanged. NOTE: unverified against live Fly routing — confirm post-deploy that a
   non-US player's ranked match now hosts nearer them (`/api/presence` region on the host).
   Remaining (design, not a bug): cross-region radius WIDENING still takes ~30–40s to reach
   the 300 ms cap, so a genuinely far full bucket can show "N/N" for a while before it starts;
   tune `RADIUS_INTERVAL_MS`/`RADIUS_MAX_MS` in `server/matchmaking.ts` if faster (looser)
   cross-region pairing is wanted.

---

# HANDOFF — 2026-07-21 (friend system: challenge / rich presence / notifications / recently-played) — READ FIRST

## "Play a friend" mode-picker menu — BUILDABLE SLICE DONE (2026-07-22, see top of file)

User wanted a **"Play a friend"** flow where, when challenging a friend, you pick the FORMAT:
1v1 unrated, 1v1 rated, 2v2 ranked (friend as your teammate), 2v0 duo record, etc. **The
buildable formats (1v1/2v2 casual + 2v0 duo record) SHIPPED 2026-07-22** (`ChallengePicker.tsx`;
see the top-of-file handoff). **1v1 rated + 2v2 ranked-with-friend remain OPEN** (shown disabled
"Soon" in the picker) — they need the server work the feasibility map below describes:
- **1v1 unrated (custom), 2v2 unrated (friend as teammate), 2v0 duo record** — all buildable
  today with existing pipes. The current `FriendsCtx.challenge` already does 1v1-unrated; duo
  record just needs `inviteToRoom(..., 'record', 'duo')` + route to `duorecord`.
- **1v1 RATED / 2v2 ranked-with-friend** — NOT possible today. Rating (Glicko) is applied ONLY
  to matchmaker-staged rooms: `Room.ranked` is set true ONLY in `applyPending()`
  (`server/room.ts:642-644`), reached ONLY when a `pending_matches` row exists for the code
  (`server/index.ts:704-707`), which ONLY `Matchmaker.assign` creates (`matchmaking.ts:257`).
  A code/invite-joined room can NEVER produce a rated result. "1v1 rated with friend" needs a
  new path to stage a rated PendingMatch for an invited pair; "2v2 ranked-with-friend"
  additionally needs a PARTY/premade concept in the matchmaker (none exists — it actively
  dedups same-account and splits alliances blindly by index, `matchmaking.ts:200-202,249-250`).
- Entry-point idea: a "Play a friend" mode-select tile AND upgrade the per-friend Challenge
  button into a format picker. `RoomInvite`/`room_invites` would need a `ranked`/mode field to
  carry the intent (today it carries only room/game/kind/record).

---

## This session (latest) — chess.com-style friends overhaul

Build (`ELECTRON=1`/web) + strict `tsc` + `npm run server:check` + `npm test` (~unchanged,
no `src/sim`/`config.ts` touch) + `npm run contrast` (167, unchanged — new CSS reuses audited
token pairs) ALL GREEN. Boot-verified via the `verify` Electron recipe: shell mounts, FRIENDS
panel renders, no console errors, no crash (the App render now wraps in a provider — the risky
bit — and it's clean).

Four features (user asked for all four, "best-value slice" — so real-time is fast adaptive
polling, NOT a WebSocket rebuild):

1. **Direct Challenge / Play** (the headline — previously you could ONLY invite from inside a
   lobby). A **Challenge** button on every online, non-DND, non-in-match friend row (`FriendsPanel`),
   on a friend's **profile** (`ProfileFriendActions`), driven by `FriendsCtx.challenge(username)`:
   generate a room code (`generateRoomCode`), send a `versus` room invite, then host that room
   (`onHostRoom` → `App.hostForChallenge` sets `pendingAutoJoin` + navigates to `lobby`). The
   invited friend gets the normal room invite and Joins into the same code. Reuses the existing
   invite plumbing end-to-end — NO new invite kind, NO protocol change.

2. **Rich presence** ("In a match · DECODE" / "In a lobby · Chain" / "Online"). New **migration
   `0018_presence_activity.sql`** adds `activity` + `activity_game` to `user_presence`. The
   `GET /api/friends` heartbeat now carries `?a=<menu|lobby|match>&g=<decode|chain>` →
   `touchPresence(userId, activity, game)`; `listFriends` returns `activity`/`game` per online
   friend (BLANKED for offline/invisible, same as last-seen). Client `FriendRow` gained
   `activity`/`game`; `presenceLine()`/`canChallenge()` in FriendsPanel render it. Activity is
   sourced from the CURRENT screen: the provider reports `'menu'` on shell screens; `InviteFlyout`
   reports `'lobby'`; and a fire-and-forget beat in `App` (game/record/matchmaking screens, 30s)
   reports `'match'`/`'lobby'` from the full-screen surfaces that render OUTSIDE the provider (so
   you don't silently drop offline mid-match). Backward-compatible: old server ignores the params,
   old client just omits them.

3. **Notifications** — `FriendToasts` (bottom-right stack, `friendsContext.tsx`), rendered inside
   `AppShell` ONLY (menu shell — never over the field, per product decision #5). The provider diffs
   each poll for NEW incoming requests / invites (primed off the FIRST payload via the new
   `useFriends().ready` flag, so it never announces the backlog on load) and pushes actionable
   toasts (request → Accept/✕; challenge → Join/✕). A soft self-contained WebAudio `chime()` gated
   on master-sound (`sound` prop). Auto-expire oldest every 9s.

4. **Real-time feel (low-lift)** — `useFriends` replaced the fixed 30s/120s `collapsed` cadence
   with ADAPTIVE polling: `POLL_HOT_MS` 6s when anything's pending (incoming/outgoing/invites),
   `POLL_IDLE_MS` 20s otherwise; recursive `setTimeout` reschedules off the latest data; catches up
   on `focus` + `visibilitychange`; still ONLY polls while the tab is visible.

**Plus (mid-session ask): "friend recently-played people".** `RecentlyPlayed` section in
`FriendsPanel` (client-only, NO server change): `fetchUserMatches(myUserId, {limit:25})` →
`recentPeople()` flattens `players[]` to distinct non-self usernamed opponents+teammates, freshest
first, minus anyone already friend/pending/blocked; one-click **Add** (≤6 shown). `myUserId`
threaded App → AppShell → FriendsPanel.

**Architecture change to know about**: `useFriends` was mounted 3× (panel, profile, invite flyout
= triple poll where they co-mounted). Now there's ONE shared store — **`FriendsProvider` /
`useFriendsCtx` in `src/ui/friendsContext.tsx`** — wrapping `AppShell` in `App.tsx`. `FriendsPanel`
and `Profile`/`ProfileFriendActions` read the ctx. `Lobby`'s `InviteFlyout` DELIBERATELY keeps its
own `useFriends` (it's a full-screen surface rendered OUTSIDE the provider — that's also what
heartbeats `'lobby'` presence during a lobby). `useFriendsCtx()` throws outside the provider by
design.

**DEPLOY NOTE**: this includes a SERVER + DB migration change (`0018`, `server/db/repo.ts`,
`server/api.ts`). Follow the deploy protocol — commit on the server branch → `./scripts/fly-deploy.sh`
→ verify `/health` → clients auto-deploy. The migration is additive (`add column if not exists`) and
the protocol stays backward-compatible (query params optional, new `FriendRow` fields tolerated), so
old clients keep working against the new server and vice-versa. Not yet deployed/committed as of this
writing.

Files touched: `server/db/migrations/0018_presence_activity.sql` (new), `server/db/repo.ts`,
`server/api.ts`, `src/net/api.ts`, `src/ui/useFriends.ts`, `src/ui/friendsContext.tsx` (new),
`src/ui/FriendsPanel.tsx`, `src/ui/ProfileFriendActions.tsx`, `src/ui/Profile.tsx`,
`src/ui/InviteFlyout.tsx`, `src/ui/AppShell.tsx`, `src/ui/App.tsx`, `src/ui/shell.css`.

---

# HANDOFF — 2026-07-20 (profile-menu top bar + Changelog page)

## This session (latest) — top bar consolidated into a profile avatar; footer gets a Changes page

Build + tsc + `npm test` (unaffected — no `src/sim`/`config.ts` touch) + `npm run contrast`
(167, unchanged count — new avatar/popover colors all reuse already-audited token pairs)
all green. Verified visually via the `verify` skill's Electron screenshot recipe (see its
gotcha below — **you must `ELECTRON=1 npm run build`**, not a bare `npm run build`, or the
file:// load renders a blank white window with no console error, since `base` is `/` and
the absolute `/assets/...` script 404s under `file://`. Lost real time to this — worth
fixing the `verify` SKILL.md to say so explicitly).

**Top bar**: the always-visible trio (region `<Select>` + name chip + sign-out button) is
now ONE avatar circle (`ProfileMenu.tsx`, replaces `AccountButton.tsx`) showing the first 2
characters of the player's display name/email, uppercased. Click opens a popover
(`.ds-profile-pop`) with: the account row (→ Account settings), the server region picker +
on-demand Ping (embeds the existing `ServerMenu.tsx` unmodified, gated on `multiServer()`
same as before), and Sign out / Sign in. Only used when `authEnabled` — the no-auth build
keeps the old bar-level `ServerMenu` + plain "Settings" button untouched (there's no user to
hang an avatar on). **Gotcha fixed while wiring this up**: the mobile media query that hides
`ServerMenu` on a narrow bar was `.ds-bar-right .ds-server-menu` (descendant) — since the
popover's copy is ALSO a descendant of `.ds-bar-right`, that rule would have hidden it inside
the popover too, at any width. Narrowed to `.ds-bar-right > .ds-server-menu` (direct child)
so it only ever matches the old bar-level fallback copy.

**Footer reorg**: the bare `GitHub` external link is gone from the footer; a `Changes` button
sits in its place (between Contributors and Discord) and opens a new full page,
`Changelog.tsx` (`/changelogs` route, wired like Contributors/Download — a footer
destination, not a `ShellNav` rail tab). It lists every published `Announcement` (patch/
season/act) newest-first via `fetchAnnouncements(100)` — the SAME feed `Announcements.tsx`'s
one-time "What's New" modal already reads, just without the seen/unseen filter, so it's a
permanent browsable history instead of a toast you only see once. Reuses `.ann-item`/
`.ann-badge`/`.ann-md` (styles.css) — confirmed self-contained, not dependent on the modal's
`.ann-panel`/`.ann-overlay` ancestors. A "GitHub" button lives in the panel header instead —
still one click, just not the footer's top billing.

**"Fix dropdowns"** — read as the same request as the top-bar redesign, not a separate bug.
Went looking for an actual defect first (`Select.tsx`'s ARIA listbox, the native `<select>`
sites in MatchHistory/PeriodPicker/Lobby/Admin, `grep -i dropdown`) and found nothing broken
in the code or CLAUDE.md/HANDOFF history. The one clear, evidenced read: this repo had *just*
gained a top-bar region `<Select>` (commit `8d44ab9`, pulled in at the start of this session —
local was 12 commits behind `origin/friendslist`), and the user's next two asks were about
that exact bar. Consolidating it into the profile popover (fewer permanent controls in a
crowded bar, dropdown still one click away) is the fix under that reading. If a distinct
dropdown bug turns up later, it's still open — this session didn't find one to close.

**Not committed.** `git status` is clean except the new/changed UI files listed above —
nothing has been staged or committed this session.

---

# HANDOFF — 2026-07-20 (merged friendslist → main, deployed; fixed a deploy footgun + a migration race) — READ FIRST

## This session (latest) — friendslist shipped; deploy protocol corrected; COST PASS

### Cost pass (2026-07-20) — read before touching machine sizes

**The big win was a WAKE LEAK, not machine sizes.** `ServerPicker` called `pingAll`,
which probes each region via `/health?region=`; the server fly-replays that to the
target machine and `auto_start_machines` BOOTS it. The picker renders on the record-run
setup screen, so every player starting a run woke all five regions — and the satellites
are only cheap while STOPPED. Replaced with the approach `server/regions.ts` already used
for the matchmaker: probe our own region once, estimate the rest via `accessMs +
interRegionMs()`, matrix served from the new `GET /api/regions`. Estimated rows render
with a `~`. **Confirmed working: syd was observed `stopped` afterward** — the first
auto-stop we'd seen.

**Sizes now:** iad `shared-cpu-4x`/1024MB · every other region `shared-cpu-1x`/1024MB
(sjc joined the satellites in `scripts/fly-deploy.sh`).

**iad left dedicated CPU — but only after MEASURING** (the fly.toml note records a shared
CPU flapping before, so this was not done blind):
- `GET /api/perf` (new, `server/index.ts`) reports EVENT-LOOP LAG percentiles, cores in
  use, rooms/players, RSS. Lag is the right metric: a throttled machine stalls the loop
  until `/health` misses its probe and the machine flaps. Note the histogram's ~10ms
  resolution floor — real lag ≈ reported − 10.
- Benchmarked the room loop: ~0.02 cores (1 robot) to ~0.03 (2v2), i.e. 33–55 rooms per
  core. Idle draw 0.01 cores, RSS ~80MB.
- Conclusion: the old flap was `shared-cpu-1x`, whose baseline ≈ one busy room. Fly's
  baseline scales with cores, so 4x has multiples of that headroom.
- **STILL UNVERIFIED UNDER LOAD**: every sample so far was `rooms: 0`. Sample
  `/api/perf` during real matches. If p99 climbs toward the 16.67ms step budget, go to
  `shared-cpu-8x` or back to `performance-1x` — throttling is a cliff, not a gradient.
- Fly enforces a 2048MiB memory floor on `performance-*` sizes; shared sizes don't, which
  is why RAM could finally drop to 1024 (actual use ~80MB).

## Merge + deploy work

**State: green + deployed.** `npm test` ALL PASS · `npm run build` clean ·
`npm run contrast` 167 checks pass · `npm run server:check` clean.

**Merged `friendslist` → `main`** — a clean FAST-FORWARD (main had nothing the branch
lacked), 6 commits / 1852 insertions: friend room invites + profile friend actions
(`InviteFlyout.tsx`, `ProfileFriendActions.tsx`, `useFriends.ts`, `UserSearchBar.tsx`,
`Select.tsx`), migration `0017_room_invites.sql` + repo/api wiring, AA contrast fixes,
and the `/frontend-consistency` skill. Pushed. Server deployed; migration `0017`
CONFIRMED applied (`[server] database ready` in the boot logs — that line only prints if
`migrate()` resolved).

**DEPLOY FOOTGUN — I hit it, then fixed the docs (`4ad201d`).** I deployed with a bare
`flyctl deploy --remote-only` because that is what CLAUDE.md's deploy protocol said. That
re-applies fly.toml's single `[[vm]]` to EVERY machine and silently UPSIZED the three
satellites (lhr/syd/nrt) from `shared-cpu-1x`/1024MB to `performance-1x`/2048MB. The user
caught it. Machines are restored and verified. **Always deploy via
`./scripts/fly-deploy.sh`** — it re-shrinks the satellites afterward. CLAUDE.md now says
so, and `docs/deploy.md`'s sizing bullet (which still described the pre-downgrade
`performance-2x`/`performance-1x` split) is corrected to today's
`performance-1x` (iad/sjc) / `shared-cpu-1x` (satellites).

**MIGRATION RACE fixed (`server/db/migrate.ts`).** All 5 regional machines call
`migrate()` at boot simultaneously. On a genuinely new migration two could both see a
file as pending; the loser hit `schema_migrations`' primary key and threw — and since
`index.ts:825` treats a migration failure as NON-FATAL, that machine logged "records
disabled", **skipped its remaining migrations, and kept serving traffic**. Now a
session-level `pg_advisory_lock` (key `MIGRATE_LOCK_KEY`) serializes the whole scan+apply
on its own client, released in a `finally` so a failure can't wedge every other machine's
boot; the insert also got `on conflict do nothing`. Note this failure mode was
SILENT-BY-DESIGN — `/health` returns `ok` regardless, so a healthy app never proved a
migration landed. Check the logs for `[server] database ready` vs `migration failed`.

## Previous session — a11y floor fixed at the root; audits all green

Ran the `/frontend-consistency` skill against the built app (10 routes, `vite preview
--port 4173`). Build green, `npm test` ALL PASS, `npm run contrast` **167 checks** (was
153), `npm run shiftaudit` 932 state changes / 0 shifts, live audit **0 FAIL** (was 3).

**Root cause of all four failures was ONE rule the repo already wrote down** (shell.css
top-of-file: *"A colour that is both a FILL and a TEXT colour will fail one of the two…
use its `-ink` sibling"*) — applied at the token definitions but violated at call sites:
- `.ds-opt.red/.blue .ot` painted raw `--ds-red`/`--ds-blue` as 13–15px type
  (4.20:1 / 4.14:1 dark, **3.27:1 light**) → now `--ds-red-ink`/`--ds-blue-ink`.
- `.ds-startpos-status.ok/.bad` painted `--ds-ok`/`--ds-red` as type (4.04:1) → `-ink`
  siblings. `.bad` was latent (not rendered in the audited state) — fixed anyway.
- `.ds-opt.on .od` inherited `--ds-mut` (tuned against `--ds-panel`) onto the SELECTED
  row's `--ds-accent-soft` ground = 3.78:1. This is the previous session's known finding,
  now CLOSED. Right surface, wrong ink — not a bad value.

**New token `--ds-accent-soft-mut`** (light `#2f6455` 5.11:1 · dark `#7cc0a8` 4.96:1):
the muted sibling of `--ds-accent-soft-ink`, for sub-labels on a selected row. It also
**replaced `color-mix(--ds-accent-soft-ink 78%, transparent)`** on `.ds-rail-btn.on .rh`
— that magic percentage cleared AA on dark (4.70:1) but **NOT on light (4.20:1, 11.5px
type)**. That one was invisible to the browser audit, which only ever sampled dark.

**Gap this exposed:** `npm run contrast` passed 153/153 while the live DOM failed. It
asserts TOKEN pairs; these were CALL-SITE pairs (a token composited onto a `color-mix`
ground it was never tuned for). Added **14 pairs** covering the selected-row grounds, the
tinted option rows, and the startpos banner, using the existing `composite()` helper.
Verified the new pairs actually bite by reverting one value → 2/167 FAILED in both themes.
**When adding a tinted/selected state, add its call-site pair — token coverage ≠ DOM
coverage.**

### Adjudicated WARNs (24, deliberately NOT "fixed" — read before acting)
- **near-duplicate colors** — LEGITIMATE. The tonal surface ladder is the documented
  depth model (`DESIGN.md` "Elevation & Depth"); design-guide §4.2 names it as the worked
  example of a threshold that bends to the contract.
- **7–12 button clusters/page** — mostly legitimate named components (`.ds-btn/.ds-cta/
  .ds-tile/.ds-opt/.ds-key/.ds-seg/.ds-tab/.ds-rail-btn/.ds-mark`), but there is a long
  tail of single-instance looks worth a pass someday.
- **19 font sizes vs the contract's 5 roles** — real sprawl, but `10.5px` (8+ call sites)
  and `9.5px` are de-facto mono micro-label ROLES. The cross-page-drift list is partly an
  artifact of which 10 routes were audited, not true drift. Fix = codify the real roles in
  `DESIGN.md`, not find-and-replace.
- **33% 4px-grid adherence** — the sharpest contract/code divergence: `DESIGN.md` claims
  an 8px rhythm, but the most-used step is `10px`, then 12/16/8/2/4/18/14/9/22/13/3. Per
  design-guide §2 you either follow the contract or amend it — **amending `DESIGN.md` to
  record the real rhythm is the recommendation**; re-spacing a tuned UI is high-risk churn.
  Left for the user to decide.
- **touch targets <24px** (`.ds-foot-link` 63×16, `.ds-key` 34×23, `input.ds-range` ×22)
  — WCAG 2.2 §2.5.8, still open from last session; a WARN, not an audit FAIL.

**Gotcha:** `npm run shiftaudit` inherits `ELECTRON_RUN_AS_NODE=1` from agent shells and
dies at `app.disableHardwareAcceleration` — `audit.cjs` self-respawns clean but
`shiftaudit.cjs` has NO such guard. Run it from PowerShell after
`Remove-Item Env:ELECTRON_RUN_AS_NODE`. Worth porting the guard.

## Previous session — frontend-consistency skill (no src/ changes; build state unchanged from below)

Built `/frontend-consistency` (user request via the skill generator): audits any website's
frontend for design consistency AND guides styling away from the generic "AI look".
- **`audit.cjs`** (Electron, pattern of `shiftaudit.cjs`): loads URLs, extracts computed
  styles from the live DOM → typography/color/spacing/radius/shadow token sprawl, per-page
  button/input/link style CLUSTERS, WCAG contrast on composited backgrounds, a CDP
  forced-`:focus-visible` probe, heading structure, 375px overflow + touch targets,
  cross-page drift, screenshots + report.txt/json. Exit 1 on a11y-floor FAILs.
- **`design-guide.md`**: per-site design contract modeled on the root `DESIGN.md` (Google
  Stitch output — token frontmatter + prose decisions), researched avoid→replace tables of
  recognizable AI-generated patterns (impeccable.style/slop, 925studios), fit-to-site
  principles (thresholds bend to the contract; a11y FAILs don't).
- Verified end-to-end this session: example.com clean; 3 local routes (`vite preview
  --port 4173`) → 1 FAIL · 9 WARN with real screenshots.
- **Hard-won gotchas (in SKILL.md, don't rediscover):** agent shells export
  `ELECTRON_RUN_AS_NODE=1` (driver self-respawns clean); **electron.exe exits -1 silently
  given 2+ bare URL args — the `--` separator before URLs is mandatory**; Git Bash
  intermittently 127s multi-URL electron invocations → invoke from PowerShell.
- **Real app finding worth fixing (✅ FIXED in the session above — kept for context):** dark theme
  `/configure/robot`: option-description text `span.od` `#949e98` on the `.ds-opt.on`
  green tint `#22463c` = **3.78:1 (needs 4.5)** — 6 spots. `npm run contrast` misses it
  (that pair isn't in its hardcoded list); add the pair there when fixing. Also: 4
  `.ds-foot-link`/footer targets are 16px tall (<24px WCAG 2.5.8), and `input.ds-range`
  renders 22px tall on mobile width.



## This session — merged `main` into `friendslist`

`main` shipped two friends fixes (accept-bug hotfix, deployed; blocked-list UI) after
`friendslist` diverged with its own player-to-player work (search, blocked section, room
invites, profile actions — commit `e1e99a5`). Merging combined both:

- **`server/api.ts`** — kept `friendslist`'s `/api/friends/invite/dismiss` route, and
  switched the "every remaining route names another player" username resolution from the
  claim-time `normalizeUsername` to `main`'s `lookupUsername` (the accept-bug fix — a
  4-char floor was rejecting legacy short usernames like `ace` before the DB was ever
  consulted). `normalizeUsername` stays for the actual claim routes.
- **`src/ui/FriendsPanel.tsx`** — kept `friendslist`'s Invites section + the `waiting`
  badge (`incoming.length + invites.length`) on the collapsed rail, and took `main`'s
  always-rendered `FoldSection` Blocked list (was conditionally rendered + un-folded on
  `friendslist`; `main` changed it to always show, folded, so "have I blocked anyone?" has
  an answer even when the list is empty).
- **`HANDOFF.md`** — this rewrite; both sessions' write-ups follow below.

**Not re-verified after the merge** — run `npm run build`, `npm test`, `npm run
server:check`, and `npm run contrast` before trusting this tree, then the two-account
security checklist in `docs/friends-list-plan.md` §Verification and a live invite
send/receive/auto-join pass (both `game: 'decode'` and `game: 'chain'`).

`server/db/migrations/0016_friends.sql` **and** `server/db/migrations/0017_room_invites.sql`
are written but **have NOT been applied**. Per the main developer's standing rule, Claude
writes the `.sql` and never runs `flyctl deploy`. Until someone deploys, the friends AND
room-invite endpoints 404 on the live server — which the client handles deliberately:
`FriendsUnavailableError` renders "Friends aren't available on this server yet", never an
error boundary. **The client is therefore safe to ship first.** Both migrations are purely
additive (`create table if not exists`, no drops/type changes), so rollback is just "deploy
the previous server".

## Prior session (`main`) — two friends fixes, shipped

Build green: `npm run build`, `npm run server:check`, `npm run contrast` (151). `npm test`
not re-run — nothing under `src/sim/` or `config.ts` was touched.

### 1. `55432d6` — "Accepting friend request says bad request" (SERVER, deployed to Fly)

**Root cause, confirmed against the production DB, not inferred.** All three pending
requests were from the account `ace` — a **3-character** username. The friends routes
validated the *target* name with the **claim-time** validator:

```ts
const USERNAME_RE = /^[a-z0-9]{4,20}$/;      // 4-char minimum
const username = normalizeUsername(body.username);
if (!username) return json(400, { error: 'bad request' }), true;
```

`'ace'` fails the 4-char floor, so the name was rejected **before the DB was ever
consulted** — an opaque 400 on accept, decline, block, everything naming that account,
with no way for either side to clear it. `ace` is the only one of 407 usernames that
fails today's rule (claimed 2026-07-07, presumably before the minimum was raised).

The diagnostic tell: `/api/profile/ace` worked fine. Those public routes do a plain
lowercase-and-look-up; only the friends block ran a format check. **A claim rule and a
lookup rule are different things** — that's the general lesson, and it's why the fix is a
split rather than a loosened regex:

- `lookupUsername` (`^[a-z0-9]{1,20}$`) bounds a key that names an EXISTING account and
  lets the DB decide existence. Used by every `/api/friends/*` route.
- `normalizeUsername` (unchanged, strict) stays where a NEW name is claimed
  (`/api/user/username`). Do not merge these back together.
- The 400 body is now `No player named.` rather than `bad request`.

Also closed the adjacent hole: **`/api/friends/request` now requires the SENDER to hold a
username.** 26 profiles have none; the recipient accepts by naming the sender *by
username*, so a usernameless sender would plant a row nobody could ever act on. The
`UsernameGate` normally guarantees one but deliberately doesn't trap users when its
profile fetch fails — which leaves exactly that hole.

**Deployed**: `flyctl deploy --remote-only`, all 5 machines healthy, `/health` ok.
Verified post-deploy that `POST /api/friends/accept {"username":"ace"}` now reaches auth
(401) instead of 400. The authenticated path was NOT exercised — that needs the user's
token. Those three requests from `ace` should now accept; worth confirming.

### 2. `96728d6` — blocked list + unblock (CLIENT only, Vercel auto-deploys)

Blocking was a one-way door **in the UI only**: `friends.data.blocked` was already
fetched every poll and `friends.unblock` was already wired to `POST /api/friends/unblock`.
The panel simply never rendered either. So this was pure presentation — no API, protocol,
or DB change.

- `FriendsPanel.tsx`: a **Blocked** section (rows + Unblock, plus a line on what a block
  does), between "Sent" and "Add a friend". Renders only when non-empty and starts
  **folded** (new `FoldSection`) — blocked players shouldn't hold permanent space in a
  panel otherwise about people you want to see, but an unblock buried in settings is worse.
- `FoldSection` is deliberately **not** `.fr-section`: that class is `display: flex`, and a
  flex `<details>` has a history of leaking its closed content in some engines. Plain block
  box, column layout on an inner `.fr-fold-body`.
- `shell.css` `.fr-fold`: summary reuses `.fr-sec-h` typography so a fold reads as a peer
  of the plain sections; the ▸ marker **rotates in place** rather than reflowing the header
  (a reflowing marker would move every row below it on open — see `npm run shiftaudit`).
- Unblock is `disabled` rather than sending `''` for a usernameless row. Unreachable in
  practice, but that empty-string lookup is the exact shape of the bug in §1.

**NOT visually verified** — the section only renders when you have a block, and that needs
your account. Production has exactly 1 `friend_blocks` row; if it's yours it'll appear.

### Branch state — `alpha`, `beta`, `main` are now IDENTICAL

Both were reset/fast-forwarded to `main` at `a9fc501`+.

Worth knowing before the next branch sync: `git rev-list --count` showed `beta` as **1
ahead** of main (`54e261d`, netcode anti-stutter — snapshot coalescing + prediction lead
cap + ping graph), which looks like unmerged work. **It is not.** That commit's content was
already ported to main wholesale — `MAX_PREDICT_LEAD 40`, `PING_INTERVAL_MS 300`,
`INTERP_DELAY_TICKS 5`, `PingGraph`, and `room.ts`'s `stepOnce(): boolean` coalescing are
all present on main under a different SHA. `git diff main beta` outside `HANDOFF.md` was
EMPTY.

**The ahead/behind count measures commits, not content.** A cherry-picked or
re-applied commit stays "ahead" forever. Trying to merge it back produced conflicts and a
`Duplicate function implementation` on `PingGraph` (tsc caught it — a resolution that only
removes conflict markers can still be wrong, so always build the merged tree). Diff the
trees before believing a branch holds unique work.

## Earlier session — MERGED `friendslist` → `main` + deployed to Fly

The friends list, Contributors page, and audio volume sliders (branch `friendslist`, 3
commits) were reviewed and **merged into `main`** (merge commit). All green on the merged
tree: `npm test` (smoke), `npm run contrast` (151), `npm run server:check`, `npm run build`.

- **Only conflict was `HANDOFF.md`** (docs) — resolved. Every code file auto-merged
  cleanly: main's mobile-touch-layout work and friendslist's audio restructure touch
  disjoint regions of `settings.ts`/`types.ts`/`App.tsx`; `game.ts`/`smoke.ts` likewise.
- **Pre-merge hardening (collation).** `0016_friends.sql`'s `friendships` CHECK was
  `(user_low < user_high)` under the column's DB collation, but `repo.ts` builds the
  ordered pair with JS `<` (UTF-16 byte order on ASCII auth subjects). A libc/ICU DEFAULT
  collation could order a pair OPPOSITELY → the INSERT violates the CHECK → a pair-dependent
  500. Fixed the CHECK to compare `collate "C"` (byte order == JS `<` for ASCII), so the
  pair repo.ts inserts always satisfies it. Surgical (CHECK expression only — PK index and
  FKs keep the default collation). Also fixed a stale `respondToBlock`→`blockUser` comment.
- **DEPLOY.** After this merge commit, `flyctl deploy --remote-only` (app
  `dohun-sim-decode`) ships the server; `migrate()` applies `0016_friends.sql` on boot
  (additive, `create table if not exists` ×4 + the `user_presence` table — distinct from
  main's machine-level `presence` table in `0015`), then verify `GET /health`. Vercel
  auto-deploys the clients from `main`.
- Review verdict: friends security model is sound (actor is always the JWT `sub`; wire
  carries usernames not user ids; blocks report generic failures; invisible/offline resolved
  server-side; LIKE wildcards escaped, prefix-only search; ProfileCols allowlist). Remaining
  LOW findings are self-healing concurrency edges (reciprocal-request race, block-vs-request
  race) — accepted, not blocking. Still worth running the two-account curl security checklist
  in `docs/friends-list-plan.md` §Verification against the live DB now that it's up.

## Prior session (`friendslist`) — player-to-player interactions (commit `e1e99a5`)

Six features, all committed on `friendslist`. **`npm run build`, `npm run server:check`,
`npm run contrast` (153 checks), and `npm test` all green.**

1. **Records search bar** — `UserSearchBar.tsx` (new), debounced public username lookup,
   sits between the "Records" title and the Leaderboard/Career tabs.
2. **Friends panel reorder + Blocked section** — order is now Invites → Requests → Online
   → Offline → Sent → **Blocked** (new — was wired in `useFriends`/server but never
   rendered) → Add a friend (moved to the very end).
3. **Nicer Status dropdown** — new `Select.tsx`, a themeable ARIA listbox (button trigger +
   floating popup, arrow-key nav). Swapped in for the Status picker ONLY — the other 7
   native `<select>` sites (region pickers, period filters, Admin) are untouched by design.
4. **Profile friend/block actions** — `ProfileFriendActions.tsx` (new), shown next to
   Share on any profile that isn't your own; mounts its own `useFriends()` instance.
5. **Room invites** — new table `room_invites` (`0017_room_invites.sql`, **not deployed**),
   `POST /api/friends/invite` + `/invite/dismiss` folded into the existing
   `GET /api/friends` poll (no new poll timer). Sending: an "Invite friends" flyout
   (`InviteFlyout.tsx`, new) in `Lobby.tsx`'s room header, lists online friends. Receiving:
   two independent surfaces both reading the same `invites` array — `FriendsPanel`'s new
   Invites section (works from anywhere via `App.tsx`'s `onJoinInvite` → `pendingAutoJoin`
   → navigates + auto-joins) and `InviteFlyout` in Lobby's own entry screen (for when
   you're mid-decision there). **Both paths call the exact same `join(roomCode)`** Lobby
   already uses for manual code entry — no parallel join logic, so it can't diverge from
   or interfere with normal joining. The invite payload carries `game`, so a CR invite
   lands the invitee in `ChainStartSelector`, not DECODE's editor.
6. Everything touched (`Records`, `FriendsPanel`, `Profile`, `Lobby`, `Select`) is shared,
   game-agnostic UI — no per-game branching was needed; verified via passing `chain:`-
   prefixed smoke cases (untouched, since no `src/sim`/`config.ts` file changed).

**Not verified this session** (needs a local DB / two live accounts / an Electron
session — none available here): `npm run shiftaudit` (reordered friend rows, the new
Select popover, and the invite chip/flyout are exactly the pressable-layout-change shape
this audit exists to catch); live two-account invite send/receive/auto-join for both
games; the friends-system security checklist above. Migrations must be deployed by the
main developer before any of this works against the live server.

## Previous session — friends list (PR #4)

Branch `friendslist`. **`npm run build`, `npm test`, `npm run server:check`, and
`npm run contrast` (now 151 checks) are all green.**

- **Migration `0016_friends.sql`** — `friend_requests` (pending only, deleted on
  resolve), `friendships` (ONE row per unordered pair, `check (user_low < user_high)`, so
  a friendship can't half-exist), `friend_blocks` (one-way), and `user_presence`.
  Presence is its OWN skinny table, NOT columns on `profiles`: the ~30s heartbeat would
  otherwise rewrite the whole `profiles` row (Postgres UPDATE is copy-on-write, including
  the `settings` jsonb) on the table every leaderboard/profile/match read also hits — and
  it makes keeping last-seen out of the PUBLIC profile reads structural rather than a
  discipline one future `select *` breaks.
- **`server/db/pool.ts` gained `tx()`** — `q()` takes a connection per call, so a
  sequence of `q()`s is not atomic. Accepting a request is "delete the request AND insert
  the friendship"; a half-applied version either drops a request nobody honoured or mints
  a friendship nobody agreed to.
- **`repo.ts` friends section.** The security properties are structural, not vigilance:
  accept/decline/cancel/remove are CONDITIONAL writes scoped to the caller and return
  false on no match (⇒ handler 404s), so **accept is authorised by the DELETE itself** —
  a client naming a request that was never sent gets a 404, not a friendship. `remove`
  binds one side of the pair to the caller, so it can't delete two strangers' friendship.
  `listFriends` reaches presence only THROUGH the caller's own friendship rows, so no
  query shape here can return a non-friend's presence. **`invisible` is flattened to a
  plain offline row IN THE SQL** — a server that sent `{online:true,status:'invisible'}`
  and trusted the component not to render it would leave the truth in a payload any
  friend can read in devtools. Offline durations are `coarsen`ed to the buckets the UI
  renders (5min/1h/1d); second precision would be a needlessly exact activity log.
  `searchUsersByUsername` is a PREFIX match on `username` (not the admin substring search
  on `handle`, which would let anyone enumerate every display name) and **escapes LIKE
  wildcards** — `?q=%` would otherwise return the whole table.
- **`server/api.ts`** — one `/api/friends*` block (Bearer JWT; the subject is ALWAYS the
  token `sub`, no endpoint takes an actor parameter) + public `GET /api/users/search`.
  The wire carries **usernames, not user ids**, so a leaked friends list doesn't hand out
  valid auth-provider `sub` values. **The friends READ doubles as the presence
  heartbeat** — no `/api/presence/ping`, because the poll that refreshes everyone else's
  status already proves the caller is here, and with no user id on the wire there is
  nothing to forge. A block reports the SAME generic failure as any other refusal: a
  distinct message would let someone confirm they'd been blocked.
- **Client** — `authedJson` in `net/api.ts` (the existing `getJson` is the *public*
  reader and sends no Authorization header, so a friends read through it would just 401);
  `useFriends.ts` owns the poll timer, cache, and optimistic mutations; `FriendsPanel.tsx`
  + `.ds-friends`/`.fr-*` CSS. **The poll only runs while `document.visibilityState` is
  visible** — otherwise every abandoned background tab pings a scale-to-zero Fly machine
  ~2,900×/day AND keeps that player eternally "online" while they're asleep, which is
  both a cost problem and a wrong answer. 30s open / 120s collapsed.
- **Panel layout** — a flex sibling in `.ds-body` mirroring `NavRail`, never
  `position:fixed` (`.ds-app` is the only scroll container). Collapsed by default (a new
  account has no friends; an expanded panel would be a column of empty state on every
  screen) with an **incoming-request badge on the collapsed rail** — without it a request
  is invisible until someone happens to expand, and the feature quietly doesn't work.
  Force-collapses between 901–1100px, where there's room for the rail and content but not
  a third column; that's a CONSTRAINT, not a preference, so the stored open/closed choice
  survives and widening restores it. Below 900px `.ds-body` is already a column, so the
  panel becomes a full-width strip ordered under the rail.
- **Status is spelled out in words**, not carried by dot hue alone — a red DND dot and a
  green online dot are the same dot to a red-green colourblind player.
- **`scripts/contrast.mjs` gained 16 pairs** (135 → 151) for the panel's `--ds-bar`
  ground and the Contributors cards. Worth knowing: contrast.mjs audits a HARDCODED pair
  list, so a green run does NOT imply new CSS was checked — new colour pairs must be added
  there or the pass is meaningless.

**Still not verified:** `npm run shiftaudit` (Electron loads the script as plain Node in
this shell — `app` undefined at `shiftaudit.cjs:36`, an environment problem unrelated to
these changes). The friends rows are new pressables in a new flex column, which is exactly
the shape of change that audit exists to catch — run it locally. Also untested: the
resize behaviour across both breakpoints, and the whole friends feature end-to-end.

**Nothing is committed.** `docs/friends-list-plan.md` §Sequencing calls for FOUR separate
PRs, and PRs #1/#3/#4 all touch `App.tsx`, so the split needs deliberate staging rather
than one lump commit.

## Previous session — display-name fix, volume sliders, Contributors page

Branch `friendslist`. **Build + `npm test` + `npm run contrast` all green.** These are PRs
#1–#3 of the four-PR split in `docs/friends-list-plan.md`; **PR #4 (the friends list itself)
is NOT started** — it needs a DB migration and, per the main developer, Claude generates the
`.sql` but never runs the deploy.

- **§3 display-name fix** (`App.tsx`, `AccountButton.tsx`, `Account.tsx`). Root cause: the
  header pill read `user.name` (the immutable Neon Auth sign-up name), the Profile page read
  the app's mutable `handle` — two sources, never synced. App now owns
  `handle: string | null | undefined` (fetched once per sign-in via `fetchProfile`) and passes
  it to `AccountButton`, which prefers it over `user.name`. `undefined` renders `…` rather
  than the auth name, so a page load doesn't *flash* the very bug being fixed. `Account` takes
  `onHandleSaved` (→ `Identity` → `DisplayName`), fired after `updateHandle` resolves, so the
  pill updates on save instead of on reload. Kept OUT of `AccountSync`'s effect deliberately —
  that one is guarded by a module-level `syncedUser` whose retry semantics shouldn't apply here.
- **§2 volume sliders** — 4 categories replacing the 2 booleans. `GameSettings.audio` is now
  `{ volume: {master, game, sfx, voice}, sounds, voice }`. **`sounds`/`voice` are LEGACY MIRRORS,
  not dead fields**: settings sync per account and one account is shared across client versions,
  so an old tab / old Electron install still reads only those two booleans. `audioMirrors()`
  re-derives them in `coerceSettings` (load) and `syncAudioMirrors()` in App's `update()` (the
  one choke point for edits — a slider drag never passes through coerce). Legacy blobs migrate
  `sounds:false → master 0`, `voice:false → voice 0`. **Round trip through an old client loses
  the levels but keeps the mute** — smoke-checked.
  `MatchAudio` swapped `soundsEnabled`/`voiceEnabled` for `masterVolume/gameVolume/sfxVolume/
  voiceVolume` + a `gain(category)` helper; WAV cues set `.volume` per *play* (was static at
  construction) so a slider applies immediately; `tone`/`noiseBurst` scale there since every
  synthesized effect funnels through them. **`ensureCtx` no longer early-returns when muted** —
  a browser only starts an AudioContext from a user gesture, so refusing to build one at
  master 0 meant raising the slider mid-match stayed silent until reload; `startKeepAlive`
  now warms it. Voice at 0 keeps the old beep fallback exactly.
  UI: `AudioSection.tsx` `VolumeRow` (`.ds-field`/`.ds-range`/`rangeFill`, step 5), auditions
  its category on pointer-up/key-up (never `onChange` — a drag would stutter), greys the value
  when master is 0. **8 new smoke checks** cover the migration in both directions.
- **§4 Contributors page** — `src/contributors.ts` (hand-maintained roster) +
  `src/ui/Contributors.tsx` + `.contrib-*` CSS in `shell.css` + route `/contributors` +
  a footer link beside Download (public — deliberately NOT admin-gated like Download).
  Display names are fetched live per card via `fetchProfileByUsername`, falling back to a
  static `fallbackName`, so a rename never staleness the page and a cold/absent game server
  still renders. **⚠️ The roster is incomplete on purpose**: names + GitHub URLs came from
  `CONTRIBUTORS.md`, but `discordAvatarUrl` / `discordUrl` / `inGameUsername` are recorded
  NOWHERE in the repo and must be collected from each person. Every field except
  `fallbackName` is optional and the card degrades (initials avatar, no icons, non-clickable
  name), so the file can be completed one contributor at a time.

**Not verified this session:** `npm run shiftaudit` — Electron in this shell loads the script
as plain Node (`app` is undefined at `shiftaudit.cjs:36`), an environment problem unrelated to
these changes. Worth running once locally: AudioSection swapped `.ds-opt` buttons for
`.ds-range` inputs, and Contributors adds new pressables (`.contrib-name`/`.contrib-icon`,
written to move only via `transform`/colour, never a border or margin).

---

---

# HANDOFF — 2026-07-19 (server spec clamp is now GAME-AWARE — CR chassis limits match the config menu)

## Latest session — server-side chassis limits == config-menu limits (CR record runs)

Build + tsc + smoke (`npm test`) + `server:check` all green.

**Bug:** Chain Reaction record runs (and ranked/custom) resized the chassis differently
from the config menu. CR runs its own length envelope (`CHAIN_MIN_LENGTH`=10 ..
`CHAIN_MAX_LENGTH`=18); DECODE clamps length to the per-intake range (sloped 13.5–15). The
config menu (`Menu.tsx`) + the actual CR spawn (`createChainWorld`→`coerceSpec(...,'chain')`)
were already game-aware — but the SERVER ingress sanitizers weren't: `sanitizePlayer` /
`sanitizePlayerPatch` in `src/net/sanitize.ts` called `coerceSpec` WITHOUT the `game` arg, so
a CR robot's length got clamped with DECODE's intake range before it ever reached the
chain-aware spawn (e.g. length 10 → 13.5). That sanitized spec is what lands on the roster,
feeds the setups, and gets recorded into the replay.

**Fix:** thread `game` through the server clamp so server limits == config-menu limits:
- `src/net/sanitize.ts`: `sanitizePlayer(raw, game?)` and `sanitizePlayerPatch(raw, current,
  game?)` now pass `game` into `coerceSpec`.
- `server/index.ts`: join → `sanitizePlayer(msg.player, cfg.game)`; spectate →
  `sanitizePlayer(undefined, r.config.game)`; ranked queue → `sanitizePlayer(msg.player,
  msg.game==='chain'?'chain':'decode')`.
- `server/room.ts`: update patch → `sanitizePlayerPatch(msg.patch, c.player, this.game)`.
- Smoke: 6 new checks in the sanitize block (CR keeps length 10/18; DECODE range still
  applies with no game arg — regression guard both ways).

Backward-compatible (no protocol change — just widens the accepted CR envelope to match what
the menu already offers). **Needs a Fly deploy** (`flyctl deploy --remote-only`) to take
effect on the live server; until then the deployed server keeps the old DECODE clamp for CR.

---

## Prior session — Chain Reaction: UI polish — game-aware footer + game-prefixed URLs

Build + tsc all green. Changes are UI-only (no `src/sim`/`config` touch, so smoke unaffected).

- **Footer is now game-aware.** `AppShell` took a static `CURRENT_SEASON` (always DECODE) →
  now takes a `game: GameId` prop and renders `seasonFor(game)` → "DSIM · Chain Reaction 2026"
  vs "DSIM · DECODE 2025–26". Wired from `App.tsx` (`game={settings.game}`).
- **Every URL is now game-prefixed** (user picked "both prefixed"): `/decode/…` and `/chain/…`.
  All routing lives in `App.tsx`. `pathFor(screen, args, game)` prepends `/${game}` (home =
  `/decode` / `/chain`); `screenSuffix` is the un-prefixed part. `parsePath(pathname,
  fallbackGame)` strips a leading `/(decode|chain)` segment (→ the game) then `parseScreen(rest)`
  (the old body, incl. legacy `/leaderboard`→records etc.). Unprefixed OLD links fall back to the
  last-selected game and are canonicalized on load (replaceState). The `settings` initializer
  `switchGame`s to the URL's game up front (so a `/chain/…` deep load spawns CR's loadout on the
  FIRST render); a mount effect persists it + canonicalizes the URL. `navigate`/`onGame`/popstate
  all thread `settingsRef.current.game`; popstate + `onSyncLoad` reconcile the game (URL is
  authoritative for the ACTIVE game — account settings don't revert a deep-linked game).
  Verified via Electron-over-HTTP (`vite preview`, file:// can't route): `/`→`/decode`, switch→
  `/chain`, `/chain/records`, deep-load `/chain/configure/robot`, legacy `/leaderboard`→canonical.
- **document.title** now names the game ("Chain Reaction · DSIM" / "DECODE · DSIM"), effect on
  `settings.game`. Static `index.html` `<title>` is just the pre-hydration placeholder.
- **GameView field aria-label** was hardcoded "DECODE field" → now game-aware via `hud?.game`.
- **Top-right Settings button** now matches Sign in (both `ds-btn`; dropped `ghost`) —
  `AccountButton.tsx` signed-out branch + `App.tsx` no-auth fallback.
- **Homepage Discord + GitHub pills** (`HomeMenu.tsx` `.ds-home-links`, styled in `shell.css`):
  prominent bordered pills with inline brand SVGs, centered under the game switcher above the
  Play menu. Reuse `LINKS` from `seasons.ts`; the footer links stay as secondary. No new tokens.
- **One-time Chain Reaction disclaimer** ("just for fun / not realistic / don't use for real
  robot design"): local-only flag `src/chainDisclaimer.ts` (`decodesim.chainDisclaimer.v1`, like
  `theme.ts` — NOT in synced `GameSettings`). `App.tsx` effect on `settings.game` sets
  `showChainDisclaimer = game==='chain' && !seen`; the `.overlay` modal (GOT IT →
  `markChainDisclaimerSeen`) sits with the other menu guards inside the AppShell block. Verified:
  shows on first CR select, dismiss persists, never reappears.

### Leaderboard "shows DECODE when CR selected" — NOT a client bug (deploy-gated)
The client is already fully game-keyed (`api.ts` appends `&game=chain`; `Records`/`Leaderboard`/
`Stats` thread `settings.game`). You still see DECODE because `.env` points at the LIVE Fly server
`wss://dohun-sim-decode.fly.dev`, which runs the **undeployed** DECODE-only server + DB — migration
`0012_game_boards.sql` and the game-keyed queries only exist on this private branch, so the live
server ignores `?game=chain` and returns DECODE rows. There is NO client-side fix (the rows look
identical). Resolves when the CR-aware server is deployed (private-branch rule: not until told) or
by running a local CR server (`npm run server` + a DATABASE_URL). Left untouched per that rule.

## Prior session — fire-rate tune (turret ~10.5 bps / drum ~27 bps)

- Turret `CHAIN_FIRE_INTERVAL` 1/9→1/12 (~8.8→~10.5 bps), drum `CHAIN_DRUM_INTERVAL` 1/41→1/37.5
  (~30→~27 bps). See "fire rates" below. Build + ~205 smoke + client/server tsc all green.

## Prior session — physical turret aim + Front/Side intake mount

- **Physical turret aim** (user: shots should depend on physical state, not pre-solved). The CR
  turret now SLEWS toward the lead solution at `CHAIN_TURRET_SLEW` (4 rad/s) and `launchToAccel`
  fires along the ACTUAL `r.turretHeading` + real velocity (no re-solved lead). Steady driving
  tracks perfectly; a SUDDEN shove (collision) jumps the solution faster than the turret follows,
  so shots fire along the stale heading and MISS. `makeChainRobot` seeds `turretHeading` aimed at
  the goal (it slews, so it must start aimed). Smoke: settled/steady = accurate, sudden shove =
  18.5° error. (Teleporting tests reset `turretHeading` — a real turret tracks continuously.)
- **Intake MOUNT selector (Front / Side)** — NOT a new style; the same sweeper on the front or
  the left+right edges (`RobotSpec.intakeSide`, like the shooter Front/Rear). `chainIntakeBand` is
  a discriminated union (`side:false` front box / `side:true` two side bands); `interact` +
  `drawChainIntake` + `RobotPreview` handle both. Side mount holds fewer (`CHAIN_STORE_SIDE_MULT`
  0.6). **The intake is part of the non-ball collision hitbox** (user): `footprintExtents` moves
  the `INTAKE_PRESETS[intake].reach` from the FRONT to the SIDES for a side mount (the Rapier
  collider uses `robotExtents`), so both mounts' rollers collide with walls/robots like DECODE.
  `coerceSpec`/`DEFAULT_SPEC` carry `intakeSide`; Menu has the Front/Side buttons.

## fire rates: turret ~10.5 bps, drum ~27 bps

- **Turret**: `CHAIN_FIRE_INTERVAL = 1/12` → ~10.5 balls/s observed (deterministic). User asked for
  "like 11 bps, slightly faster". 11 is UNREACHABLE at 60 Hz: the achievable rates near it are 10.0
  (1/11), **10.5 (1/12)**, and 12.0 (1/13) — the re-anchor-to-actual fire tick rounds a sub-6-tick
  interval UP, so the values quantize in jumps. 10.5 is the closest to 11 and the "slight" bump from
  the old ~8.8. (Old was `1/9` → 8.8 bps.)
- **Drum**: `CHAIN_DRUM_INTERVAL = 1/37.5` → ~27 balls/s observed (user: "dumper slightly slower at
  ~27" — interpreted as the DRUM, since the actual dumper flings its whole hopper at once with no
  per-ball bps). The NOMINAL is set below 1/27 s to counter the throughput lost to 60 Hz tick
  quantization (a shot fires on the next tick past its due time, so a sub-3-tick interval rounds UP)
  + the symmetric jitter; the OBSERVED cadence measures ~27 balls/s. (Old was `1/41` → ~30 bps.)
  Both verified empirically with a throwaway rate-measurement script (removed).

## PER-GAME loadouts (robots + start positions no longer bleed cross-game)

- **`GameLoadout`** (types.ts) = {spec, savedRobots, startIndex, startPose, startCat,
  savedStartPoses, startMemory}. `GameSettings.loadouts?: Partial<Record<GameId, GameLoadout>>`
  archives the NON-active games; the flat fields are always the ACTIVE game's copy.
- **`switchGame(settings, game)`** (settings.ts) archives the current game's loadout and restores
  the target's (or a fresh `defaultLoadout(game)`), so DECODE and CR each keep their own robot,
  saved-robot library, and start positions. Active assists follow the restored spec's drivetrain.
  App's game switcher (`onGame`) now calls it. `coerceSettings` validates the archive
  (`coerceLoadout`, per-game `coerceSpec`).
- **Fixed a pre-existing bug**: the flat `startIndex` clamp used DECODE's `START_POSES.length`
  even for CR, so CR anchor 3 clamped to 2. Now game-aware via `startPoseCount(game)`.
- Smoke: a DECODE build + saved robot + start survive a CR round-trip; a CR 18"-long build +
  anchor 3 survive; switching hides the other game's saved robots.

## mecanum best on beams, CG range 0.3–1.5, CR length to 18

- **Mecanum is the BEST beam-crosser** (suspension + low CG); swerve worst. `TRACTION` reordered
  (mecanum .91 / tank .90 / xdrive .89 / swerve .87). Crucially the beam CoG penalty now scales
  with the clearance **margin above the beam** (`(clr−beamH)/(MAX−beamH)`), not absolute
  clearance — so a just-clearing chassis (clr≈1) pays NOTHING and the default isn't over-slowed.
  Crossing keeps ~mecanum .70 / tank .69 / swerve .53 / xdrive .42.
- **Ground-clearance range → [0.3, 1.5]** (`CHAIN_CLEARANCE_MIN/MAX`). CR presets' clearance
  lowered under 1.5 (Sniper 1.3, Hauler 1.5). CoG smoke test now checks the 0.3 floor = no penalty.
- **CR chassis length up to 18"** — `coerceSpec(raw, base, game?)` gained a game param; for
  `'chain'` it uses `CHAIN_MIN_LENGTH/CHAIN_MAX_LENGTH` (10–18) instead of the DECODE
  intake-limited range (~15). Threaded from CR spawn ('chain'), the Menu (`settings.game`), and
  settings.ts (active + saved specs). DECODE is byte-identical (no game arg ⇒ old path). The
  Menu length slider mirrors it. (Note: cross-game saved robots use the CURRENT game's range —
  a saved CR-length robot viewed under DECODE would clamp to ~15; acceptable edge.)

## CR storage ceiling 60 + lighter beam drag

- **Storage max raised to 60** (`CHAIN_STORAGE_MAX` 48→60; `CHAIN_STORE_AREA_PER_BALL` 6.5→5.4
  so a full 18×18 open-hopper launcher actually reaches ~60; turret still smaller via its mult).
- **Beams slow you less** (user: "too much"). Raised the per-drivetrain `TRACTION` grips
  (tank .96 / swerve .94 / mecanum .92 / xdrive .93), base cap → .98, `CHAIN_BEAM_MAX_RETAIN`
  .95→.98, `CHAIN_BEAM_MOMENTUM_EASE` .45→.55. Full-sim high-speed crossing now KEEPS ~tank .72
  / swerve .57 / mecanum .58 / xdrive .44 (was ~.53/.32/.32/.34) — still a real slowdown, just
  not crippling. Smoke's per-tick-retain threshold relaxed to `< 0.99`; storage test asserts a
  big launcher hits ~60.

## SPECTATING (watch live matches)

You can now watch any live match read-only, and there's a "Watch Live" list.
- **Server** (`room.ts`): `spectators` map separate from `clients`. `addSpectator(c)` sends the
  current `matchStart` (yourRobotId **-1**) + a snapshot, then every broadcast/snapshot (both
  `broadcast` + `broadcastSnapshot` now iterate spectators with the same delta-priming).
  Spectators never count toward capacity/roster/persistence; their control messages are ignored
  (`onMessage` already returns on unknown ids); `detach` drops them with no grace. `Room.summary()`
  → `LiveRoom` for the list (live versus matches only). `beginMatch` remembers `matchSeed/Setups`
  so a mid-match spectator gets matchStart.
- **`/api/live`** (index.ts, where the `rooms` map lives) lists every live match; the WS
  `{t:'spectate', room}` message routes to `addSpectator`.
- **Protocol**: `spectate` ClientMsg + `LiveRoom` type. `NetSession.spectator`; `ServerSession`
  takes a `spectator` flag (sendInput is a no-op when set). `LobbyClient.spectate(room)`.
- **GameController**: `spectator` mode — `localRobotId` -1, `stepServer` reconciles + steps the
  world with the snapshot's per-robot commands (no predict/send); every robot is interpolated by
  `displayWorld`. Camera from `robots[0]`.
- **UI**: `WatchLive.tsx` polls `/api/live` (4 s) and lists matches; a card → `App.spectateRoom`
  opens a spectator `ServerSession` (not saved as a rejoinable "active game"). Reached via a
  "Watch Live" tile on the mode-select `/watch` route.
- Smoke: a Room accepts a spectator, streams snapshots to it, keeps it off the roster, `summary()`
  reports it, and it leaves cleanly — all without touching the match.

## Archived-season ELO is FROZEN (historical standings)

Even though ELO persists across seasons within an act, viewing a PAST season's leaderboard/career
now shows the rating FROZEN at that season's end (not the moved-on live rating).
- **`0014_elo_history.sql`**: new `elo_history(user_id, mode, game, balance_version, rating, rd,
  vol, games)` — a per-SEASON snapshot. Written on every rated match (`upsertEloHistory` in
  `ranked.ts`, alongside `upsertRating`); while a season is live it tracks the latest rating,
  once it rolls it stays frozen = the end-of-season state.
- **Read routing**: the LIVE season reads the per-ACT board (`elo_ratings` — every currently-
  placed player); an ARCHIVED season reads `elo_history` for that `balance_version`.
  `api.ts /api/elo` branches on `season >= currentSeason` (adds `historical` to the response);
  `getUserStats` (career) picks `elo_ratings` (by act) vs `elo_history` (by season) via the same
  live check. New repo fns: `eloHistoryLeaderboard`, `eloHistoryUserStanding`, `upsertEloHistory`.
- Pre-existing archived seasons (rolled before this feature) have no snapshot rows ⇒ their ELO
  board reads empty; every season that rolls from now on is captured. Not deployed (private branch).

## Global "games played" recorded per game, combined on homepage

`getGlobalStats` (repo.ts) now groups records/matches by `(game, mode)` and returns a new
`byGame: {decode, chain}` split (games recorded SEPARATELY per game) while the headline `games`
and `byCategory` COMBINE across games (summed — note the group-by-game change means `byCategory`
now uses `+=`, not `=`). The homepage (`HomeMenu.tsx`) already renders the combined `stats.games`,
so it stays a single combined total; the per-game split is available in the API for any surface
that wants it. Client `GlobalStats.byGame?` is optional (older servers omit it).

## ELO wipes on ACT reset, records on SEASON reset

Reset semantics split: a **SEASON reset** (new `balance_version`, same act) starts fresh RECORD
boards but ELO carries over; ratings wipe **only on an ACT reset** (act++). Implemented by
keying ELO by ACT instead of season:
- **`0013_elo_by_act.sql`**: `elo_ratings` gains `act` (backfilled from `seasons`), de-dups
  colliding rows (keep highest balance_version per act), re-keys PK to
  `(user_id, mode, game, act)`, DROPS `balance_version`, index → `(game, act, mode, rating)`.
  Records/matches unchanged (still per-season). **Not deployed** (private branch; runs on next deploy).
- **repo.ts**: new `actForSeason(bv, game)`; `getRating(Full)`/`upsertRating`/`eloLeaderboard`/
  `eloUserStanding` now key by `act`; `getUserStats` resolves the season's act for its ELO query
  (records/matches stay per-season).
- **ranked.ts** `persistVersusMatch` resolves `actForSeason(bv, game)` once and rates on the act.
  **matchmaking.ts** `introElo` resolves the current act. **api.ts** `/api/elo` resolves the
  requested season's act (records endpoint stays per-season); response adds `act`.
- Net effect: `startNewSeason(bumpAct=false)` → records reset, ELO persists; `bumpAct=true` →
  both reset (fresh act). No client change needed (the extra `act` field is additive).

## CR ranked & records + per-game periods

Chain Reaction is now RANKED + RECORDED, on its OWN boards and its OWN Act → Season
progression (DECODE and CR never share a leaderboard or a period).
- **CR is scored**: `src/games/chain/sim.ts` `scored: true` — CR versus matches persist ELO +
  history, CR record runs persist to the record board, all keyed by game.
- **DB migration `0012_game_boards.sql`** (additive, `game` defaults to `'decode'`): adds
  `game` to `seasons`/`records`/`matches`/`elo_ratings`/`replays`; re-keys the seasons PK to
  `(game, balance_version)` and the elo PK to `(user_id, mode, game, balance_version)`;
  game-first board indexes; drops+recreates `record_leaderboard` with `game`. `migrate.ts`
  runs the whole file as one query, so the `DO $$` PK-swap blocks are safe. **Private branch —
  the migration has NOT run on the live Fly/Neon DB yet; it applies on next deploy.**
- **Per-game periods**: `repo.ts` season fns (`ensureSeason`/`currentSeasonNumber`/
  `listSeasons`/`startNewSeason`/`purgeSeasonReplays`) all take `game`; the live season + acts
  are resolved per game. **Chain Reaction seeds Act 1 · Season 1** (`ensureSeason(bv, 'chain',
  1)` in persist.ts + the `/api/seasons` read); DECODE keeps its act-0/beta rows.
- **Repo/persist/ranked**: every board read/write fn takes `game` (default `'decode'`) —
  records, ELO, matches, stats, history. `persist.ts`/`ranked.ts` thread `o.game`.
- **Endpoints**: `/api/records|elo|seasons|user/:id/stats|matches` accept `?game=chain`
  (default decode); admin `/api/admin/season/start` + `/records` take `?game=`.
- **Client**: `src/net/api.ts` board fns take `game?` (append `&game=chain` only for CR so
  DECODE URLs are byte-identical); `game` threads App→Records→Leaderboard/Stats→CareerView, so
  the boards/career you see follow `settings.game`. (Public `/profile` pages still default to
  DECODE — a per-profile game toggle is a possible follow-up.)
- **CR replays are now watchable** (done). `Replay.game` added; `ReplayRecorder`/`runRecordMatch`
  stamp it; `ReplayPlayer`/`simulateReplay` re-sim via `simModuleFor(replay.game)` (createWorld +
  step), so a CR replay runs through `chainStep`. `getReplay` returns the stored `game`; the
  server recorder stamps `this.game`. `ReplayView` configures the camera with `moduleFor(r.game).
  bounds` (CR's larger field) and the Renderer already draws game-aware. Old replays lack `game`
  ⇒ DECODE (no REPLAY_FORMAT bump). Smoke: CR replay round-trips byte-identical + differs from a
  same-seed DECODE re-sim.

## CR vs DECODE multiplayer audit

Verified the netcode is game-aware end-to-end and the two games never cross-contaminate:
- **Server**: `room.ts` resolves `simModuleFor(this.game)` for createWorld/step; the G304
  start-legality host gate runs only when `simModuleFor(game).startLegality` (DECODE). `game`
  comes from the staged PendingMatch / RoomConfig.
- **Matchmaking**: `bucketKey` includes `game` → a CR queuer and a DECODE queuer never pair
  (smoke: "chain and decode do NOT pair" / "two chain queuers DO pair").
- **Protocol/snapshots**: `slimWorld` spreads all non-robot/ball fields, so CR's `world.chain`
  (catalysts/scored/endgame) round-trips; `unslimWorld` defaults `game→'decode'` for old
  servers. `staged` balls serialize as full Artifacts. New smoke: CR snapshot keeps
  game='chain', preserves chain state, hash-identical, and re-steps without NaN.
- **Client**: `game.ts` resolves the module from `this.world.game` (`this.mod`) on the
  predict/reconcile hot path; `gameId = session ? session.game : settings.game`. `NetSession.game`
  is carried by ServerSession/lobbyClient.
- **FIXED — the Lobby / MatchStrategy start editor rendered DECODE geometry for CR.** New
  shared `ChainStartSelector` (used by MatchSetup, Lobby, MatchStrategy) shows CR's legal
  lab/ring-stand anchors instead; `startLegal` is forced true for CR (G04 anchors are always
  legal) so "ready up" isn't blocked by DECODE's G304.
- **KNOWN/INTENTIONAL**: CR sim module is `scored: false`, so CR multiplayer PLAYS (custom
  lobby, snapshots, results screen, drop/reconnect) but ranked ELO / records / DB persistence
  are gated OFF (persistMatch short-circuits unscored games). Flip `src/games/chain/sim.ts`
  `scored: true` to enable the ranked/records pipeline for CR (verify the results-screen ELO
  reveal + DB game-keying first).

## Beams always slow you (even at speed)

- **Beams now slow every drivetrain even at high speed** (was: momentum let mecanum/swerve
  power over at ~full speed). `beamDragFactor` (CR beams.ts) rebalanced: momentum eases only a
  LITTLE (`CHAIN_BEAM_MOMENTUM_EASE` 0.45) and the per-tick retain is hard-capped
  (`CHAIN_BEAM_MAX_RETAIN` 0.95), base cap 0.9. Full-sim high-speed crossing now KEEPS ~tank
  0.53 / swerve·mecanum·xdrive ~0.32 (was mecanum 1.00, swerve 0.97) — a clear slowdown, still
  crossable, traction spread preserved (tank best). Smoke: sim-based crossing test asserts a
  real speed loss; the old "momentum powers over" assertion was flipped.

## Wall square-up in CR + diagonal-speed audit

- **CR robots now square up flush to walls** (they didn't before). DECODE's post-Rapier
  `squareUpRobots` was never called in `chainStep`. The wall block of `squareUpStatics`
  (physics.ts) was factored into `squareUpWalls(r, preVel, halfX, halfY)`, and a new export
  `squareUpRobotsWalls(world, preVels, halfX, halfY)` runs robot-robot squaring + wall-only
  statics (no DECODE goal-face/classifier geometry, which is phantom in CR). `chainStep` now
  captures `preVels = solveRobots(...)` and calls it with `CHAIN_HALF_X/Y`.
- **Diagonal-speed bug FIXED (was real — in the ACCEL phase, not top speed).** TOP speed was
  already capped fine (`hypot` demand for swerve, L1 for mecanum/xdrive), which is why a
  peak-speed probe missed it. But `motorStep` was stepping fwd + strafe INDEPENDENTLY, so the
  velocity VECTOR accelerated at √2·accel on a diagonal → over a 0.5 s drive from rest,
  diagonal covered **33-37% more ground** for swerve/xdrive (~10% mecanum). Added
  `motorStepVec` (drivetrain.ts) — caps the accel budget in vector MAGNITUDE, not per-axis;
  robot.ts uses it for translation (angVel still 1-D `motorStep`). After: diagonal/straight
  displacement ratio ≤ 1.0 for all drivetrains. Smoke test now measures DISPLACEMENT (not peak
  speed) so it actually guards the bug. Pure-forward accel/top-speed unchanged (identical to
  the old path when strafe = 0), so the DECODE `driveSummary` calibration holds.
- **High-CG swerve is now way more sluggish** (user request). `cogFactor` (CR beams.ts) is
  drivetrain-aware: swerve uses `CHAIN_COG_SWERVE_PENALTY` (0.6) on a SQUARED clearance curve
  (tippy tall modules), vs the base `CHAIN_COG_PENALTY` (0.16) linear for everyone else — so a
  max-clearance swerve drops to ~40% authority vs ~84% for tank/mecanum.

# HANDOFF — 2026-07-19 (Chain Reaction: start positions + launcher randomization)

## Latest session — start positions, pre-match launcher randomization, fire-rate + spread tuning

- **START POSITIONS (rule G04 — start completely in the Lab Area).** `CHAIN_START_POSES`
  in `config.ts` = 4 legal named anchors (2 Lab-corner FLOOR poses + 2 RING-STAND ascended
  poses), CANONICAL for BLUE (+x), x-mirrored for RED in `spawn.ts` `chainStartPose`.
  `makeChainRobot` honours `setup.startIndex` (2-robot alliance defaults to 0/1 → the two Lab
  corners). Selector: `MatchSetup.tsx` (solo config) now shows CR start buttons (was a
  placeholder) that set `settings.startIndex`. All anchors legal by construction, so G04
  always holds. (No drag-editor yet; multiplayer Lobby/MatchStrategy still render the DECODE
  `StartPositionEditor` for CR — a latent follow-up, not wired for CR start editing.)
- **PRE-MATCH FIELD RANDOMIZATION via the goal launchers** (manual auto-score/reject).
  `createChainWorld` no longer scatters particles — it STAGES 150 per goal (`state: {kind:
  'flight', target, scored:true, staged:true}`, positioned in the goal box). New
  `prematchRandomize` in `play.ts` flings `CHAIN_PRELAUNCH_PER_TICK` (1) per goal per tick
  onto the field with a randomized arc (~2.5 s to clear both goals). Staged balls are inert
  (skipped in the flight loop) until launched; count stays conserved at 300 the whole time.
  `staged?: boolean` added to the flight `BallState` (serializes fine; worldHash unaffected).
- **Fire-rate tuning:** drum `CHAIN_DRUM_INTERVAL` 0.023→0.0115 (2× faster); turret
  `CHAIN_FIRE_INTERVAL` 0.05→0.0714 (70% of the old rate).
- **Eject spread:** `CHAIN_EJECT_SPREAD` 150→80 (narrower width-wise scatter out of the goal;
  used by BOTH the gameplay recycle eject and the pre-match launcher).

# HANDOFF — 2026-07-19 (Chain Reaction: penalty engine + single sweeper intake)

> **Intake designs collapsed to ONE: `ChainIntakeStyle = 'sweeper'`** (the full-width
> roller). Removed `'roller'`/`'funnel'` from the type, `CHAIN_INTAKES`, the Menu picker
> (now a static info row), and the funnel render branches in `drawRobot.ts`/`RobotPreview`.
> Old saves migrate automatically (coerceSpec falls back to sweeper). CR presets all use
> sweeper. Kept the type open (`'sweeper'` union of one) for future designs.


> **Branch: `chain-reaction` (PRIVATE — do NOT push/deploy until the user says so).**
> **GREEN — `npm run build` (client tsc+vite), `npm run server:check`
> (`tsc -p tsconfig.server.json`), and `npm test` (466 checks) all pass. DECODE is 100%
> unchanged.**

## Latest session — CR penalty engine (`src/games/chain/penalties.ts`)

`updateChainPenalties(world)` runs in `chainStep` BEFORE `updateChain` (so a foul awarded
this tick folds into the alliance total `updateChain` writes — it now adds
`+ scores[a].foulPoints`). CR has no `world.rrContacts`, so the engine does its OWN
OBB–OBB SAT contact test (`robotsContact`, via `robotCorners` + `CHAIN_FOUL_SLOP`).
Rules modeled — both MAJOR, awarded to the VICTIM via the shared `awardFoul`,
EDGE-triggered via `chain.foulEdge` (`${rule}-${offender}-${victim}` keys):
- **G06** — in AUTO, contacting an opponent COMPLETELY inside its own alliance section
  (its x-half, excluding the neutral Particle-Zone diamond) → MAJOR on the aggressor.
- **G05** — in END GAME, contacting an ASCENDING opponent (`chain.endgame[id]==='ascended'`)
  → MAJOR on the aggressor.
NOT modeled (deliberate): G02 plowing + G08 "prolonged restriction" (user: hard to do
well) and **G09 accelerator-exit obstruction (user removed it this session)**. G01–G04 are
structurally enforced; G07 (de-score) is legal. HUD `hud.chain.foulPts/oppFoulPts` +
GameView Results now show a CR PENALTIES row (split out of End Game).

## What this branch is

A SECOND selectable, playable game — **Chain Reaction (CR)**, the 2026 Unofficial-FTC
CAD-competition theme (presented by goBILDA) — alongside DECODE, behind the
**game-abstraction seam** in `src/games/`. Both games are playable incl. online
multiplayer. CR is now a **full game** (not the old shell): particles, accelerators,
catalysts/hooks, beams, endgame, scoring — all implemented.

The seam: `GameSimModule` (DOM-free, server-safe, in `src/games/types.ts` + registry
`src/games/sim.ts`) vs `GameModule` (client, adds canvas renderers, `src/games/module.ts`
+ registry `src/games/index.ts`). Both `moduleFor`/`gameOf` default unknown→`'decode'`.
The server tsconfig has NO DOM lib — it must only ever import `simModuleFor`. DECODE's
colliders live byte-identically in `src/games/decode/colliders.ts`.

## Chain Reaction — how it plays (all in `src/games/chain/`)

- **Field** (`config.ts`, `state.ts`, `drawField.ts`): 144" tile field; ACCELERATORS
  protrude out of each side wall (red left / blue right, `CHAIN_ACCEL_*` = manual mm),
  centered in y. FOUR HOOKS/goal at y=±688mm (`hookPos`, 2 positions × 2 stacked). RING
  STANDS near the 4 corners (climb posts). LAB AREAS = corner squares (park/leave). Central
  white PARTICLE-ZONE diamond (`CHAIN_DIAMOND_R`). Red/blue alliance divider on the vertical
  centre line, flush OUTSIDE the beam (no tape overlap). BEAMS: four **1"-wide** (`BEAM_HALF_W
  =0.5`) black tubes on the x/y axes wall→diamond = difficult terrain.
- **Particles** (`play.ts`, `draw.ts`): 300 white 3" balls, bespoke integrator +
  spatial-hash `separateParticles` (never overlap, no Rapier ball-ball). Conserved: ground
  + flight + hoppers === 300 always (ball reuse, no teleport). ACCELERATOR auto-scores an
  entering particle then REJECTS it back onto the field (further out + randomized spread).
- **Beams** (`beams.ts`, called from `step.ts`): CLEARANCE is the only hard gate
  (`groundClearance ≥ CHAIN_BEAM_HEIGHT`). Given clearance, EVERY drivetrain crosses;
  MOMENTUM dominates (a running start powers over), traction only matters creeping.
  `beamDrag` runs BEFORE `solveRobots` (scales across-velocity so the slowdown persists —
  a post-solve change is wiped by `updateRobot` re-setting velocity); `beamBlock` runs
  AFTER for no-clearance robots (hard wall). Raised clearance → `cogFactor` sluggishness.
- **Catalysts** (`play.ts` `catalystAction`): 4 purple rings START on the ring stands.
  A `catalyst` button (key C / pad LB) picks up a free ring OR de-scores a seated one
  (own or opponent goal), and seats a carried ring on a nearby own hook (+1 pt/particle
  multiplier, `accelMultiplier`).
- **Endgame**: park in a lab area (5) / ascend a ring stand (20).

### CR robot configuration (`RobotSpec` CR-only fields; scoring reworked 2026-07-18)

THREE SCORING ARCHETYPES (`RobotSpec.scoreMode`) — turret aims its own turret; **drum +
dumper are TURRETLESS chassis-wide launchers that AIM BY TURNING** (holding fire steers the
robot to face the goal via `chainAimAssist` in step.ts, then it fires once aligned; autofire
fires opportunistically without hijacking the heading). Both fire a **parallel straight-line**
of particles across the chassis width (`launchLine`, NOT converging on a point). The tall
Accelerator opening HANGS over the field, so these score from a STAND-OFF distance:
- **`turret`** (default) — dye-rotor single-shooter: auto-aims + indexes ONE per
  `CHAIN_FIRE_INTERVAL` (0.05 s) from ANYWHERE (`launchToAccel`, solved arc, never short).
- **`drum`** — chassis-wide flywheel ROLLERS streaming SINGLE particles CONTINUOUSLY: one
  every `CHAIN_DRUM_INTERVAL` (0.023 s ≈ 43/s, fast) ± `CHAIN_DRUM_JITTER` from a RANDOM
  lateral position across the width (`launchAt`) — uniform SPEED, but the pattern is never a
  uniform line. Any range. Rendered as full-width rollers (NOT a channelled drum).
- **`dumper`** — chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56", a real stand-off, not point-blank); opposite-side balls leave at
  ±`CHAIN_DUMP_SIDE_VAR` speed ⇒ scatter (< 100% accuracy). Recovers `CHAIN_DUMP_INTERVAL` (0.8 s).

GOAL INTERIOR + THROW-BACK (in `updateChain`'s flight loop): a scored particle KEEPS its
momentum and BOUNCES around inside the goal box (back/side/floor restitution `CHAIN_GOAL_REST`
+ `CHAIN_GOAL_FRICTION`), funneling toward the wall-side launcher (`CHAIN_FUNNEL_DRIFT_ACC`),
which flings it back onto the field once it's funneled back (near the wall, moving fieldward,
after `CHAIN_FUNNEL_MIN`) or `CHAIN_FUNNEL_S` max-dwell expires — NOT a snap-to-one-x instant
eject. A particle that MISSES the opening is thrown back INTO the field by a human
(`throwBack`; FOR NOW, this rule may change).

ROBOT VISUALS + RESULTS: `drawChainRobot` shows the archetype (turret / full-width flywheel
ROLLERS / catapult bucket) + intake design + hopper bar; the intake reads green whenever it
can still collect (`hopper < cap`). The FINAL SCORE screen (both PvP `Results` and solo
`RecordResults` in GameView.tsx) is CR-aware: Particles ×mult + End Game (no DECODE fouls);
`hud.chain` carries per-alliance `particlePts`/`oppMult`/`oppCatalysts`.

A REAR-SHOOTER build (`RobotSpec.shooterRear`, drum/dumper only): the launcher mounts at the
BACK, so the robot turns its BACK to the goal to shoot (`chainGoalAimHeading` += π, `launchAt`
from the rear edge). Menu toggle + preview + in-game render all honor it.

Three INTAKE DESIGNS (`RobotSpec.chainIntake`, `CHAIN_INTAKES` geometry → `interact`, measured
off the ACTUAL chassis so the capture stays ~robot-sized): **roller** (full-width, 3" bite,
all-rounder) · **funnel** (narrow 55%, 6" reach, precise singles) · **sweeper** (widest +2"
overhang, 4" bite, max volume). CR intake is a WIDE band (multi-ball per tick), PLUS a TIGHT
active-intake PULL (`CHAIN_INTAKE_PULL_R` 5" — deliberately small; draws edge particles into
the mouth for a higher rate without a large reach).

RING PICK/PLACE INDICATOR: `chainCatalystPrompt(chain, rob)` reports pickup/place availability
+ the target; the HUD shows a gold `chip prompt` (PICK UP / PLACE RING) and `drawChainBalls`
draws a highlight ring + link line on the target ring/hook. Rings can be seated on EITHER
goal's hooks (own OR opponent) — `catalystAction`/`chainCatalystPrompt` scan both alliances.

SHOOTING ON THE MOVE: a launched Particle INHERITS the chassis velocity (real physics) and the
shooter LEADS to compensate — a TURRET leads by turning its turret (`turretHeading = leadDir`),
a TURRETLESS drum/dumper leads by turning its CHASSIS heading (`chainGoalAimHeading = leadDir`);
both stay accurate while moving. `leadDir` (play.ts) solves the projectile-lead angle; launch
arcs use the NET (muzzle + inherited) velocity.

HOPPER CAPACITY is DERIVED from archetype × size (`chainStorageMax`/`chainHopperCap` in
chain/config.ts), CM-grounded: G01 = unlimited Particles, G02 bounds control to an
**18×24×18 prism**, G03 lets the robot expand into it — so no fixed count; the MAX is the
one-layer volume `CHAIN_STORAGE_MAX = 48` (18×24 ÷ 3" grid = 6×8). The formula scales chassis
footprint / `CHAIN_STORE_AREA_PER_BALL` (6.5 in²/ball — hex packing + G03 deployed-hopper
expansion past the frame) × an archetype factor: TURRET smallest (0.55, dye rotor + shooter
take center volume), DRUM = DUMPER large (1.0). The `ballStorage` slider's MAX is dynamic;
`coerceSpec` resolves scoreMode BEFORE clamping ballStorage to `chainStorageMax`. Plus
**groundClearance** (0.5–3"). `flywheelInertia`/`canSort`/DECODE intake picker hidden for CR.
(The `cm.pdf` at repo root is now READABLE — `pdftotext cm.pdf` works; the old corrupt copy
is replaced.)

ROBOT VISUALS: `GameModule.drawRobot?` hook (renderer.ts: `mod.drawRobot ?? drawRobot`).
CR's `src/games/chain/drawRobot.ts` shares the chassis + `drawWheels`/`roundRect` (exported
from `render/drawRobot.ts`, DECODE byte-identical) and draws the ARCHETYPE launcher (turret
on top · chassis-wide slotted drum · catapult bucket) + the INTAKE DESIGN + a hopper-fill
bar. `RobotPreview` has a CR variant behind a `chain` prop (Menu + MatchStrategy pass it).

FOUR CR PRESETS (`CHAIN_PRESETS`, shown in place of DECODE's `ROBOT_PRESETS` when
`game==='chain'`): **Sniper** (turret/funnel/swerve) · **Drummer** (drum/roller/mecanum) ·
**Hauler** (dumper/sweeper/tank, big storage) · **Skimmer** (dumper/roller/xdrive, fast).
All coerceSpec-stable so a card highlights when active (`chainSpecMatches`). HUD shows a
TURRET/DRUM/DUMPER chip.

## Wiring touchpoints (both games)

- `src/types.ts`: `World.game?`/`World.chain?`, `GameSettings.game`, `RobotSpec.{ballStorage,
  groundClearance,scoreMode,chainIntake}?`, `ChainScoreMode`/`ChainIntakeStyle`,
  `RobotCommand.catalyst?`, `BallState` `flight` variant `{target,scored?}`.
- `src/sim/spawn.ts` `coerceSpec`: clamps/defaults all four CR fields (enum-checks
  scoreMode/chainIntake). `DEFAULT_SPEC` carries turret+roller defaults.
- `src/sim/physicsEngine.ts`: `solveRobots`/`solveBalls` take `FieldColliders`.
- Net: `RobotCommand.catalyst` → buttons bitfield `BTN_CATALYST=4`; `game` on RoomConfig/
  queue/matchStart/strategyStart, caps-gated (`CLIENT_CAPS` has `'game'`); matchmaking
  `bucketKey` includes game. Persistence short-circuits when `!module.scored`.
- `src/ui/Menu.tsx`: CR archetype + intake-design selectors, CR presets, storage/clearance
  sliders (all gated `!isDecode`). `src/ui/GameView.tsx`: CR HUD (score, PARTICLES/MULT/
  CATALYSTS, HOPPER n/cap, TURRET|DUMPER chip). `src/game.ts` `getHud`: CR `chain` readout.

## Verify / gotchas

- `npm test` (`scripts/smoke.ts`, ~445 PASS lines) is the runtime surface — CR spawn,
  300-particle conservation, catalyst ×5 + de-score, beams (canCrossBeams/beamDragFactor/
  beamBlock), particle non-overlap, wide/multi-ball intake, **dumper in/out-of-range**,
  **intake-design funnel-reach/roller-width**, **CR-preset coerce-stability**. Add one per
  behavior change.
- **Electron GUI verify**: needs `ELECTRON=1 npm run build` first (relative base for
  `file://`), then **`npm run build` again to restore the web base** before finishing —
  do not leave the repo on the Electron build. Driver recipe in `.claude/skills/verify`;
  working scripts this session in the scratchpad (`verifyCR.cjs`).
- Determinism holds (commands + `world.rngState` only) — client prediction / server
  authority / replays are safe for CR. `chainStep` deliberately skips DECODE's
  updateRobotActions/goals/gates/penalties/DECODE-scoring.

## Still approximate (flagged in `chain/config.ts`) — awaiting exact manual numbers

`CHAIN_DIAMOND_R` (diamond size → where beams end), ring-stand exact corner positions
(`CHAIN_RINGSTAND_INSET`), lab-area geometry (`CHAIN_LAB`). Beam width (1") and hook/
accelerator dims ARE exact (manual). Archetype/intake/dump tuning values are a reasonable
baseline, not a frozen spec — tune in `chain/config.ts`.
