# Friends list + audio volume + display-name fix + Contributors page — plan

## Context

Four asks bundled together in one session:

1. A **friends list** (add/search/view players, see online/offline activity) as a
   collapsible right-side panel mirroring the existing left `NavRail`.
2. **Volume sliders** (master / beeping / voice / game sounds) to replace the current
   ON/OFF audio toggles.
3. A **display-name bug**: the header pill (top-right) shows a different name than the
   Profile page / leaderboards for the same account.
4. A **Contributors page**, linked from the footer, styled like the Configure page's
   cards, showing each contributor's Discord avatar, in-game name/username (linking to
   their profile), Discord icon, and GitHub icon.

The main developer's note on process (verbatim, for the record): this session (Claude)
has no Fly.io secrets/deploy access. For any change that needs a DB migration, Claude
generates the `.sql` migration file in `server/db/migrations/`; the **main developer**
is the one who runs `flyctl deploy --remote-only`, which is what actually applies it to
the live Neon DB. **Do not run any deploy step — stop and tell the user when the plan
reaches that point**, per `docs/deploy.md`'s existing protocol.

Everything below is scoped to reuse existing patterns rather than invent new ones —
the codebase already has a `.ds-panel`/`.ds-opt` card system, a `rangeFill()` slider
helper, a `PlayerName`-style profile-link component, and an inline-SVG icon convention.

---

## 1. Friends list

### 1.1 Data model — new migration `server/db/migrations/0016_friends.sql`

Two tables, following the existing style (`text` user ids referencing `profiles`,
`if not exists` everywhere so it's safe to re-run):

```sql
-- pending requests only; deleted on accept/decline
create table if not exists friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user_id text not null references profiles(user_id) on delete cascade,
  to_user_id   text not null references profiles(user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (from_user_id, to_user_id)
);
create index if not exists friend_requests_to_idx on friend_requests(to_user_id);

-- accepted friendships, one row per UNORDERED pair (user_low < user_high avoids
-- storing A→B and B→A separately)
create table if not exists friendships (
  user_low  text not null references profiles(user_id) on delete cascade,
  user_high text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);
create index if not exists friendships_high_idx on friendships(user_high);

-- one-way blocks: blocker never receives requests from blocked, and blocking
-- tears down any existing friendship/requests in both directions (see §1.2 rule 6)
create table if not exists friend_blocks (
  blocker_id text not null references profiles(user_id) on delete cascade,
  blocked_id text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists friend_blocks_blocked_idx on friend_blocks(blocked_id);

-- last-seen + self-set visibility. Deliberately its OWN skinny table, NOT columns on
-- `profiles` — see the note below.
create table if not exists user_presence (
  user_id      text primary key references profiles(user_id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  -- null/'online' = automatic, 'invisible' suppresses presence ENTIRELY (server-side,
  -- see §1.3), 'dnd' shows a red dot but is still "present"
  status       text
);
```

**Why a separate table rather than two columns on `profiles`** (this was the first draft;
it's worth the extra table):

- **Write amplification.** The heartbeat rewrites one row per signed-in user every ~30 s.
  Postgres UPDATE is copy-on-write, so touching a `profiles` row rewrites *the whole row*
  — including the `settings` jsonb — and leaves a dead tuple behind every time. That's a
  hot-loop of churn (and autovacuum pressure) on the table every leaderboard, profile, and
  match-save read also hits. A two-column table keeps the churn on a page nobody else
  reads, and the row stays small enough for HOT updates.
- **It makes the data-exposure question structural instead of vigilant.** `profiles` is
  selected from by several *public* read paths (`getProfile`, `getProfileByUsername`,
  `getUserStats`). If last-seen is a column there, keeping it out of public responses is a
  standing discipline that one future `select *` breaks. If it's a different table, a
  public query has to *opt in* with a join it has no reason to write.

One shaping note that survives either layout: **coarsen on the way out, not in the DB.**
Store `now()`, but have the API round offline durations to the granularity the UI actually
renders ("2d", "3h", "just now"). A raw second-precision timestamp is a needlessly precise
activity log, and the UI never shows that resolution anyway.

**Two operational notes on shipping this migration** (both pre-existing properties of
`server/db/migrate.ts`, but this is the first migration in a while and they matter here):

- `migrate()` runs the whole `.sql` file inside **one transaction**, so this migration is
  all-or-nothing — good. It's also purely additive (`create table if not exists`, no drops,
  no column type changes), so **rollback is "deploy the old server"**: the old code simply
  never touches the new tables. Say so to your dev — it makes the deploy a low-stakes one.
- `migrate()` runs at boot on **every machine, one per Fly region, concurrently.** Two
  machines starting together can both try `insert into schema_migrations` for the same
  file; the loser hits the primary-key conflict, `migrate()` throws, and that machine
  fails to boot. This is pre-existing and hasn't bitten yet (migrations have mostly landed
  with one machine warm), but it's worth knowing before a deploy that adds three tables.
  Cheap hardening if you want it: `insert ... on conflict (name) do nothing` and take a
  `pg_advisory_lock` around the loop. Out of scope for this feature — flag it, don't
  bundle it.

Also note the migrations directory already has **duplicate numeric prefixes** (`0003` and
`0012` each appear twice) and ordering is a lexical sort on the *full filename*, not the
number. `0016_friends.sql` is unambiguous; just don't assume the prefix alone orders them.

`repo.ts` additions (mirroring existing functions like `setHandle`/`getProfile`):
`sendFriendRequest`, `respondFriendRequest` (accept → delete both possible request
rows + insert into `friendships` with `[min,max]` ordering; decline → delete row),
`removeFriend`, `listFriends(userId)` (join `friendships` either side → `profiles` for
handle/username), `searchUsersByUsername(prefix, limit)` (new, public-safe — see 1.4).

### 1.2 Server endpoints (`server/api.ts`), same Bearer-JWT pattern as `/api/user/handle`

```
GET  /api/friends                      — Bearer; { friends, incoming, outgoing } + status
POST /api/friends/request  {username}  — Bearer; resolve via getProfileByUsername
POST /api/friends/accept   {fromUsername}
POST /api/friends/decline  {fromUsername}
POST /api/friends/cancel   {toUsername}   — withdraw an outgoing request
POST /api/friends/remove   {friendUsername}
POST /api/friends/block    {username} / POST /api/friends/unblock {username}
POST /api/friends/status   {status}    — Bearer; set own online/dnd/invisible
GET  /api/users/search?q=              — public, username-prefix, min 2 chars, limit 20
```

**There is deliberately no `POST /api/presence/ping`.** An earlier draft had one, called
on its own 30 s timer. But the panel is *already* polling `GET /api/friends` on a timer to
refresh everyone else's status — so a separate ping doubles the request rate to say
something the first request already proves. Have the `GET /api/friends` handler bump the
caller's own `last_seen_at` as part of serving the read:

```sql
insert into user_presence (user_id, last_seen_at) values ($1, now())
on conflict (user_id) do update set last_seen_at = now();
```

This is strictly better on every axis that matters here: half the requests against a
scale-to-zero Fly machine, one fewer endpoint to write and secure, and the "you can only
touch your own row" property from §1.2 rule 1 becomes structural rather than something the
handler has to remember — there is no user id on the wire to forge.

#### Security rules these endpoints MUST enforce (design-level, not optional)

The one genuinely security-sensitive part of this feature is that friendship is a
*mutual-consent* relation and presence is *behavioural data about a real person*. Both
have to be enforced on the server; the client is untrusted.

1. **The subject is ALWAYS the JWT `sub`, never a body/query field.** Every mutating
   endpoint derives the acting user from `verifyAuthToken(token).userId`, exactly like
   `POST /api/user/handle` does today (`server/api.ts:102-122`). No endpoint may accept
   an `actorId`/`userId` parameter naming who is acting. The presence write folded into
   `GET /api/friends` likewise touches the token's `sub` only — otherwise anyone can forge
   another account's presence (make someone look online when they aren't, or keep an
   account looking permanently online after they've left).
2. **Accept must be bound to an existing pending request.** Implement accept as a
   *conditional* statement, not read-then-write:
   ```sql
   delete from friend_requests
    where from_user_id = $1 and to_user_id = $2   -- $2 = caller (JWT sub)
   returning from_user_id;
   ```
   and only insert into `friendships` when that `delete` returned a row (wrap both in a
   transaction). Without this, a client can POST `accept` naming any user id and mint a
   friendship that the other person never agreed to — a consent bypass that then leaks
   that person's presence and (if activity labels ever ship) what they're doing. The
   same applies to `decline`/`cancel`: scope the `delete` to rows where the caller is the
   correct side, and treat "0 rows affected" as 404, never as success.
3. **`remove` must be symmetric and caller-scoped**: `delete from friendships where
   (user_low, user_high) = (least($1,$2), greatest($1,$2))` with one of the two bound to
   the caller. A caller must never be able to delete a friendship between two other
   people.
4. **Take usernames, not user ids, on the wire.** The plan originally passed
   `fromUserId`/`friendUserId`. Prefer the public `username` and resolve it server-side
   via `getProfileByUsername` — the same identifier the profile pages already use. This
   keeps the auth-provider `sub` (an internal identity-provider primary key that also
   authorises match writes) out of API responses that a broad, unauthenticated audience
   can enumerate, and it means a leaked friends list doesn't hand out a set of valid
   `sub` values. (`/api/profile/<username>` returns `userId` today; that's pre-existing,
   but don't widen it.)
5. **Presence is friends-only and server-derived — do not ship a
   `GET /api/friends/status?ids=…` endpoint.** An earlier draft of this plan had one,
   unauthenticated, taking arbitrary ids. That is a presence oracle: anyone could poll
   "is this specific person at their computer right now, and when were they last on"
   for *every* account on the service, without ever being their friend. Instead fold
   status into the authenticated `GET /api/friends` response, where the server joins
   against the caller's own `friendships` rows and therefore *cannot* return a
   non-friend's presence regardless of what the client asks for. Presence must never
   appear in the public `/api/profile/<username>` or `/api/users/search` responses.
6. **Blocking is enforced server-side.** `friend_blocks` (see §1.1) is checked inside
   `sendFriendRequest` — a blocked user's request is rejected with a generic
   "couldn't send request" (don't disclose *that* they're blocked), and blocking
   someone deletes any existing friendship + pending requests in both directions. This
   is the real harassment control; a client-side filter is not one.
7. **Response shape is an allowlist.** `listFriends`/search select exactly
   `user_id, handle, username` (+ `last_seen_at` only on the authenticated friends
   read). Never `select *` from `profiles` — that table also holds `settings` and
   whatever future columns get added, and a `select *` today silently becomes a data
   leak the next time someone adds a column.

**Search should NOT reuse `searchProfiles`** (the existing admin-only substring-on-handle
search in `repo.ts:610`, wired into `Admin.tsx`) — that's fine for a moderator but a
public substring search over `handle` lets anyone enumerate every display name on the
service. `searchUsersByUsername` should be a **prefix** match on the unique `username`
column instead, which is the same public data already exposed one-at-a-time via
`/api/profile/<username>`.

Two implementation notes on that query:

- Keep it **parameterised** (`ilike $1` with `[prefix + '%']`), matching every other
  query in `repo.ts` — never string-concatenate the query into SQL.
- **Escape LIKE wildcards in the user's input** before appending `%`: a search for `%`
  or `_` would otherwise match every username at once, turning a prefix search back into
  the full-enumeration endpoint this bullet exists to avoid. `q.replace(/[\\%_]/g, '\\$&')`
  plus the default backslash escape character.
- Also reject the empty/1-char case server-side (min 2), not just in the UI.

Beyond that: reject self-requests, duplicate requests, and requesting an existing friend
server-side (not just client-side) — same defensive posture as `updateUsername`'s 409
handling.

#### On CORS / CSRF (deliberate non-issue — don't "fix" it into one)

`server/api.ts` sends `access-control-allow-origin: *` and allows the `authorization`
header. That is safe for these new mutating endpoints **specifically because auth is a
Bearer token that JavaScript must attach explicitly**: a wildcard ACAO cannot be combined
with credentials, so a malicious page cannot make an authenticated cross-origin request
on a victim's behalf. Keep it that way — if anyone later moves auth to a cookie, every
endpoint added here becomes CSRF-able overnight and would need SameSite + an origin check
at the same time.

### 1.3 Online/offline status — the one real architectural decision here

Per the exploration in this session: **there is no existing "is this account currently
browsing the site" signal.** The header's "12 online" count (`server/index.ts`,
`onlineCount`/`authedUsers`) only counts sockets opened for lobby/queue/match — never for
someone sitting on Configure/Records/Profile — by deliberate design, to keep Fly's
auto-stop-to-zero model working (`server/index.ts:51-57`).

Recommended v1 model (extends that same polling pattern, not a standing socket):

- A single `useFriends()` hook mounted once at the `AppShell` level (i.e. wherever the
  friends panel itself is mounted, see §1.5) polls `GET /api/friends` every ~30 s **only
  while signed in**, and that same request records the caller's presence (see §1.2). One
  hook owns the poll timer, the friends/requests state, and the mutation calls, so the
  panel, the collapsed-rail badge, and anything added later all read one cache instead of
  each starting their own timer.
- **Gate the poll on `document.visibilityState`.** Without this, every background tab a
  player leaves open pings a scale-to-zero Fly machine ~2,900 times a day and keeps them
  eternally "online" while they're asleep — which is both a cost problem and a *wrong
  answer*. Poll only when the document is visible, refetch once immediately on
  `visibilitychange` → visible, and let the ~45 s freshness window mark an abandoned tab
  offline on its own. `NoticePoller.tsx` is the existing in-repo precedent for a
  shell-level interval poller — follow its shape.
- Consider backing the interval off when the panel is **collapsed** (say 30 s open / 120 s
  collapsed). A collapsed panel only needs a request-count badge to be roughly current.
- The authenticated `GET /api/friends` returns, per **friend** (never per arbitrary id —
  see §1.2 rule 5): `online` (last_seen_at within ~45s) or `offline` + a coarsened
  last-seen bucket (client formats "Offline for 2d" the same way anywhere else in the app
  already formats relative time, if such a helper exists — else add one).
- This is intentionally coarse: it means "online" ≈ "has the app open somewhere," not
  "in a match." Richer sub-labels (screenshot shows "In Menu" / "In Match (4:12)") need
  the per-user activity tag to travel through the existing per-machine `presence` heartbeat
  (`0015_presence.sql`'s `authed jsonb` column) — doable as a **follow-up**: extend each
  authed entry from a bare user id to `{id, activity: 'lobby'|'queue'|'match'}`, but the
  exact match **timer** (`4:12`) would need room start-times threaded through too, which
  `room.ts` has in-memory per-machine but isn't in the cross-machine `presence` table today.
  **Recommend shipping v1 with just Online/Offline (+ last-seen), and treating the
  richer activity labels as a stretch goal** — flag this trade explicitly to your dev
  before they decide it's worth the extra plumbing.
- **"Do Not Disturb"**: cheapest to make this a manual, Discord-style status the player
  sets themselves (`user_presence.status: 'online'|'dnd'|'invisible'|null`, null =
  automatic), not something inferred. Small addition to the same migration + a toggle in
  the panel. **`invisible` must be applied in the SQL that builds the response, not in
  the React component** — if the server sends `{online: true, status: 'invisible'}` and
  the panel merely declines to render it, the user's presence is still sitting in a
  network response any friend can open devtools and read, which defeats the entire point
  of the setting. The query should emit `offline` (and suppress `last_seen_at`) for an
  invisible friend, so the truthful answer never leaves the server.

### 1.4 Client: `src/net/api.ts` additions

```ts
fetchFriends()                              // GET  /api/friends — also records presence
sendFriendRequest(username)                 // POST /api/friends/request
respondFriendRequest(fromUsername, accept)  // POST /api/friends/accept | /decline
cancelFriendRequest(toUsername)             // POST /api/friends/cancel
removeFriend(username)                      // POST /api/friends/remove
blockUser(username) / unblockUser(username)
setPresenceStatus(status)                   // POST /api/friends/status
searchUsers(query)                          // GET  /api/users/search — public
```

Everything here takes a **username**, not a user id, per §1.2 rule 4 — and there is no
`fetchFriendsStatus` and no `pingPresence`, both of which earlier drafts had.

**Don't reach for the existing `getJson` helper for the authenticated calls.** `getJson`
(`src/net/api.ts:62`) is the *public* reader — it sends no `Authorization` header, so a
friends read through it would just 401. The authed calls follow the `updateHandle` shape
right below it (`getAuthToken()` → `fetch` with `authorization: Bearer …`). Only
`searchUsers` can use `getJson`, since search is public. Worth adding a small
`authedJson<T>(path, init?)` helper next to `getJson` rather than repeating the
token-fetch-and-header dance eight times.

**Feature-detect, don't assume.** Per `CLAUDE.md`'s deploy discipline, one Fly app serves
every client version, and the client on Vercel can go out *before* your dev deploys the
server. A 404 from `/api/friends` must render the panel's signed-out/unavailable state,
never an error boundary — same posture as `gameServerConfigured()` gating multiplayer.

### 1.5 Client: `FriendsPanel` component (mirrors `NavRail`, not `position: fixed`)

New `src/ui/FriendsPanel.tsx` + CSS added to `shell.css` next to `.ds-rail`. Structural
twin of `NavRail`/`.ds-rail`: a flex sibling (never `position:fixed` — `AppShell.tsx`'s
`.ds-body` is a flex row specifically so panels scroll with `.ds-app`, the app's one
scroll container), mirrored to the right side of `.ds-body`:

```tsx
// AppShell.tsx — .ds-body becomes a 3-way flex row when showRail is true
{showRail ? (
  <div className="ds-body">
    <NavRail active={active} onNav={onNav} showAdmin={showAdmin} />
    <main className="ds-main">{children}</main>
    <FriendsPanel onOpenProfile={onOpenProfile} />
  </div>
) : ( ... )}
```

`showRail` (already `screen !== 'home'` in `App.tsx`) is the exact same condition the
user described ("not on the home page") — reuse it verbatim rather than inventing a
second prop, so the two rails always agree about which screens show chrome.

- **Collapse/expand**: local `useState<boolean>` for expanded/collapsed, persisted to
  `localStorage['decodesim.friendsPanelOpen']` (device-level UI pref, same tier as
  `decodesim.theme` — NOT synced to the account, since it's just a layout choice).
  Collapsed state renders a slim icon-rail (a people/friends glyph button) at a fixed
  small width, same idea as `.ds-rail`'s width but the opposite edge; expanded renders
  the full list at ~240–260px.
- **Responsive behaviour — the plan's biggest missing piece.** `.ds-body` currently
  budgets for a left rail plus content. Adding a 240–260 px right panel means roughly
  500 px of the viewport is chrome, which squeezes content hard on a laptop and is
  untenable on the phone layouts this project already supports. Two rules:
  - Below a breakpoint (~1100 px), **force-collapse** the panel to its icon rail; below
    ~700 px, take it out of the flex row entirely and make it an **overlay drawer** over
    `.ds-main` (the left `NavRail` already has to solve the same problem — match whatever
    it does rather than inventing a second responsive idiom).
  - The persisted `decodesim.friendsPanelOpen` pref is a *user preference, not an
    override*: the responsive collapse must win, and re-widening the window should restore
    the stored choice. Storing "open" on a desktop and then loading on a phone must not
    produce a panel that eats the screen.
- **Default collapsed on first run.** A brand-new account has zero friends, so an expanded
  panel is a column of empty state on every screen. Default to collapsed and let the first
  expand persist; the badge (below) is what earns the expand.
- **Sections** (per the screenshot): "Online" (avatar + colored status dot + activity
  label), "Offline" (grayed avatar + "Offline for Xd"), an "Add friends" search box +
  results list, and incoming/outgoing request rows (Accept/Decline buttons on incoming).
- **Incoming-request badge on the collapsed rail.** If the panel defaults collapsed and
  auto-collapses on narrow screens, an incoming friend request is otherwise invisible until
  someone happens to expand it — the feature quietly doesn't work. A small count badge on
  the collapsed glyph (from the same `useFriends()` state) fixes it.
- **Debounce the search box** (~250 ms) and drop responses that arrive out of order —
  every keystroke otherwise fires a request at a machine that may be cold-starting, and
  a slow early response can overwrite the results for a longer query.
- **Mutations should be optimistic with rollback**, then reconciled by the next poll:
  accept/decline/remove all have an obvious local effect, and a 30 s poll interval is far
  too long to wait for a row to disappear after clicking Accept.
- **Not signed in / auth disabled**: render a compact "Sign in to add friends" state,
  matching `AccountButton`'s / `Account.tsx`'s existing `IdentityDisabled` fallback
  rather than a bare empty panel.
- **Row component**: reuse the existing `PlayerName`-shaped pattern from
  `src/ui/Leaderboard.tsx` (handle + `@username`, click → `onOpenProfile(username)`) for
  every friend/search-result/request row instead of writing new profile-link logic —
  it's exactly "handle, username, click-through to profile" already.
- Search results and the friend list both link straight to `/profile/<username>` via the
  `openProfile()` plumbing that already exists in `App.tsx` (`navigate('profile', {username})`).

**Scope note on full-screen surfaces**: `game`/`lobby`/`matchmaking`/`record`/`duorecord`/
`replay` bypass `AppShell` entirely today (`App.tsx` early-returns before ever reaching
it), so the friends panel won't appear there without extra plumbing. Treat "every screen
except Home" as "every `AppShell`-wrapped screen" for v1 (Modes, Configure, Records,
Profile, Watch, Download, Account, Admin) — extending into live-match/lobby screens is a
separate, larger change (those screens intentionally own their own minimal chrome) and
should be its own follow-up if wanted.

---

## 2. Volume sliders (master / beeping / voice / game sounds)

Today there are only two booleans (`GameSettings.audio: { sounds, voice }`,
`src/types.ts:418-421`), and "beeping" (synthesized SFX) vs. "game sounds" (the FIRST
field-recording WAVs) are **not distinct categories anywhere** — both are gated by the
one `sounds` boolean in `src/audio.ts`. This is a real (small) refactor, not just a UI
change.

### 2.1 `src/types.ts` / `src/settings.ts`

```ts
audio: {
  master: number; // 0–1
  game: number;   // 0–1 — the 6 FIRST field-recording cues (start/end/resume/warning/...)
  sfx: number;    // 0–1 — synthesized shoot/intake/gate tones + countdown beep fallback
  voice: number;  // 0–1 — announcer speech; 0 substitutes the beep fallback, same as today
};
```

- `defaultSettings()`: `{ master: 1, game: 1, sfx: 1, voice: 1 }`.
- `coerceSettings()`: clamp each 0–1 (reuse the existing `clamp()` used for
  `parkSpeedPct`); **migrate the legacy boolean shape** so old saved settings don't
  reset to silent: if `s.audio.sounds`/`s.audio.voice` are booleans (no numeric fields
  present), map `true → 1` / `false → 0` onto `game`, `sfx`, and `voice` respectively,
  `master` defaults to `1`. Coerce **per field**, not all-or-nothing, per `CLAUDE.md`'s
  existing rule — a half-migrated blob should lose one field, not the whole audio object.
- **Keep writing the legacy booleans for a transition period.** `GameSettings` syncs to
  Postgres *per account*, and the account is shared across client versions — a player who
  moves a slider on the new build and then opens an old tab (or an Electron install they
  haven't updated) will have `s.audio.sounds === undefined` there, and the old
  `coerceSettings` falls back to its default. That's not catastrophic (audio comes back
  ON), but it silently un-mutes someone who deliberately muted. Cheap fix: when saving,
  also emit `sounds: (master * game) > 0` and `voice: (master * voice) > 0` as derived
  booleans. New clients ignore them; old clients read them and behave correctly. Drop the
  extra fields a release or two later. This is the same backward-compatibility discipline
  `CLIENT_CAPS` enforces on the wire protocol, applied to the settings blob.

### 2.2 `src/audio.ts` (`MatchAudio`)

Replace `soundsEnabled`/`voiceEnabled` booleans with the four gain fields above.
Every hardcoded volume literal becomes `master * category * originalLiteral`:

- `play(cue)` (the 6 WAV cues, currently `a.volume = 0.55` fixed at construction) →
  set `a.volume` on each `play()` call to `masterVolume * gameVolume * 0.55` (was a
  static per-element `.volume`; now recomputed per play so slider changes apply live).
- `tone()`/`noiseBurst()` (feeds `sfxShoot`/`sfxIntake`/`sfxGate`/`beep`) → multiply the
  `vol` parameter by `masterVolume * sfxVolume` at each call site (or once, inside
  `tone`/`noiseBurst` themselves, since every caller already funnels through those two).
- `say()` → `u.volume = masterVolume * voiceVolume * 0.9`; keep the existing fallback
  behavior exactly (`voiceVolume === 0` ⇒ substitute `beep()` on `interrupt` calls, same
  as today's `!voiceEnabled` branch) so countdown timing/UX doesn't change.
- `ensureCtx()`/`muted` getter: skip *emitting* when `masterVolume === 0` — but **do not
  skip creating the `AudioContext`.** Browsers only allow an `AudioContext` to start from
  a user gesture; if master is 0 when the player clicks into a match, refusing to construct
  it means that when they later drag master up mid-match there's no gesture left to unlock
  it and audio stays dead until reload. Construct on the first gesture as today, and gate
  output at the gain instead. (The current code gets away with the early-out because the
  boolean can only change from the menu, which is itself a gesture.)
- **Consider a real gain graph instead of multiplying literals at each call site.** A
  `masterGain → {gameGain, sfxGain}` node chain means a slider drag applies to
  already-scheduled audio, and there's exactly one place volume is computed rather than a
  multiplication that has to be remembered at every future `tone()` call. The WAV cues run
  through `HTMLAudioElement`, not the graph, so those keep the per-`play()` `.volume`
  assignment — but the synthesized side is all `tone()`/`noiseBurst()` and is a clean win.
  If you keep the multiply-at-call-site approach, at least funnel it through a single
  `gain(category)` helper so the two paths can't drift apart.

`src/game.ts:264-265` wiring becomes:
```ts
this.audio.masterVolume = settings.audio.master;
this.audio.gameVolume = settings.audio.game;
this.audio.sfxVolume = settings.audio.sfx;
this.audio.voiceVolume = settings.audio.voice;
```

### 2.3 `src/ui/AudioSection.tsx` — reuse the existing slider pattern, not a new one

The app already has a styled range input (`rangeFill()` in `src/ui/rangeFill.ts` +
`.ds-range` CSS + the `.ds-field`/`cap`/`val` markup used throughout `Menu.tsx` and
`ControlsSection.tsx` for every other numeric setting). Swap the two `.ds-opt` ON/OFF
buttons in the "Audio" `.ds-panel` for four sliders in that exact idiom:

```tsx
<label className="ds-field">
  <span className="cap">Master <span className="val">{Math.round(settings.audio.master * 100)}%</span></span>
  <input className="ds-range" type="range" min={0} max={100} step={5}
    value={settings.audio.master * 100} style={rangeFill(settings.audio.master * 100, 0, 100)}
    onChange={(e) => setAudio({ master: Number(e.target.value) / 100 })} />
</label>
```
...repeated for Game sounds / Beeping (SFX) / Voice lines, all inside the same
`.ds-panel` "Audio" card (no new card needed). Keep the existing hint text about voice
falling back to beeps when its slider is at 0%.

Three UX details worth deciding up front rather than discovering in review:

- **Audition on release.** A volume slider with no audible feedback is guesswork — play a
  short representative cue for that category on `onPointerUp`/`onKeyUp` (not on every
  `onChange`, which would machine-gun). The `sfx*` functions already give you one-shots.
- **`step={5}` is right for the mouse but coarse for the keyboard.** It's fine — just be
  aware arrow keys will move in 5 % jumps.
- **Indicate when master is 0.** With master at 0 the other three sliders still show their
  own values while producing silence, which reads as a bug. Dim them, or show "Muted" next
  to the master value.
- **Accessibility**: these are the first sliders to carry a percentage in a `.val` span —
  give each an `aria-label` (or `aria-labelledby` pointing at the `.cap`) so the control
  announces as "Master, 80%" rather than reading the raw number out of context.

---

## 3. Display-name bug — root cause found and confirmed

**The header pill and the Profile page read the display name from two different, never-
synced sources.**

- `src/ui/AccountButton.tsx:39` — `<b>{user.name ?? user.email ?? 'Player'}</b>` — this is
  the **raw Neon Auth session name** (whatever was typed at sign-up, or the Google OAuth
  name) via `authClient.useSession()`. It is never updated after sign-up.
- `src/ui/Account.tsx`'s `DisplayName` component (the one the Profile screenshot shows)
  fetches the **app's own mutable `handle`** via `fetchProfile(userId)` — literally
  commented `// load the current handle from the server (may differ from the auth name)`
  (`Account.tsx:131`) — and that's what gets saved via `POST /api/user/handle` and shown
  on leaderboards/public profiles.

So the moment someone edits their display name in Profile (auth name "syun gin" → handle
"Fe"), the header pill keeps showing the stale auth name forever, because it was never
wired to `handle` at all. This matches the screenshots exactly (pill: "syun gin", public
profile header: "Fe").

### Fix

- Lift a small `handle: string | null` state into `App.tsx` alongside the existing
  `accountUserId` (`App.tsx:299`), populated by `fetchProfile(uid)` once per sign-in —
  same call `DisplayName` already makes, just hoisted up (or folded into `AccountSync`'s
  existing `onUser` callback, extending it to also deliver the fetched handle).
- Pass `handle` down to `AccountButton` and render `handle ?? user.name ?? user.email ??
  'Player'` instead of `user.name ?? ...` (`AccountButton.tsx:39`).
- Thread an `onSaved(handle)` callback down through `Account` → `Identity` →
  `DisplayName`, called right after `updateHandle()` resolves (`Account.tsx:156-159`), so
  the header updates **immediately** on save rather than waiting for next reload/refetch.

Two details that decide whether the fix actually *looks* fixed:

- **Don't flash the wrong name while the fetch is in flight.** `handle ?? user.name ?? …`
  renders the stale auth name for however long `fetchProfile` takes, then swaps — which is
  the exact bug the user reported, briefly, on every page load. Render the pill's name
  slot empty (or a skeleton) until `handle` resolves; the avatar/chrome can draw
  immediately so there's no layout shift.
- **Mind `AccountSync`'s module-level `syncedUser` guard.** It exists so returning to the
  menu never re-fetches and clobbers unsaved local edits, and it means a handle fetched
  through that path happens *at most once per session*. That's fine given the `onSaved`
  callback covers same-tab edits — but it does mean a rename in another tab won't reach
  this tab's header until reload. Acceptable; just don't be surprised by it, and don't
  "fix" it by weakening the guard, which would reintroduce the settings-clobber it prevents.

No DB/migration/server change needed — this is purely a client wiring fix, and it is the
one item here with no deploy dependency at all (see Sequencing).

---

## 4. Contributors page

### 4.1 Data source — new `src/contributors.ts`

No Discord OAuth or avatar data exists anywhere in this codebase (auth is Neon Auth only;
`server/auth.ts` has no Discord fields). A contributor's Discord avatar/links are **not**
derivable from the account system, so this needs a small hand-maintained static config,
cross-referenced with the existing `CONTRIBUTORS.md` (currently: Dohun Kim as owner, plus
4 pre-CLA contributors — Baron/@BaronClaps, Shaan Sridhara, Felix D, therealkingcob):

```ts
export interface Contributor {
  discordAvatarUrl: string;
  discordUrl: string;   // profile or invite link — clarify which with the team
  githubUrl: string;
  inGameUsername: string; // the ONLY thing used to look up their live handle — see below
}
export const CONTRIBUTORS: Contributor[] = [ /* filled in by hand */ ];
```

Someone (you, coordinating with each contributor) needs to collect each person's Discord
avatar URL, Discord link, GitHub link, and in-game `username` — this file is not
self-service and has to be updated by hand per new contributor, same as `CONTRIBUTORS.md`
already is today.

Because this file is hand-maintained and code-reviewed, the URLs in it are trusted input
and don't need runtime sanitising — but two things are worth doing anyway, since the file
is the kind of thing that gets edited casually later:

- **Consider vendoring the avatars** into `public/contributors/` rather than hotlinking
  `cdn.discordapp.com`. Discord CDN avatar URLs expire/rotate when someone changes their
  picture (dead images), and hotlinking means every visitor's browser makes a request to
  Discord from your page. A committed 64×64 PNG per contributor is smaller than the
  problem it removes. If you do hotlink, add `referrerPolicy="no-referrer"` on the `<img>`.
- **Type the links as `https://` only** and keep them literal in the config — never build
  a contributor URL from anything a user can influence. (`javascript:` in an `href` is a
  real XSS sink that React does *not* block; it's only safe here because the value is a
  constant in a reviewed source file, so keep that property.)
- Add `rel="noreferrer"` alongside `target="_blank"` on both icon links, matching the
  existing footer links in `AppShell.tsx`.

**Don't hardcode the display name** — the whole point of §3's fix is that `handle` is the
one source of truth and can change any time. The Contributors card should fetch each
person's *current* handle live via the existing `fetchProfileByUsername(username)` (same
call `Profile.tsx` already makes) at render time, so a contributor's card never goes stale
if they rename themselves later.

**But the page must render completely without the game server.** The live-handle fetch is
an enhancement, not the content. Three things follow, and they're easy to get wrong:

- Put a **`fallbackName` in the static config** and render it immediately, upgrading to the
  fetched handle when/if it arrives. Otherwise the page is a grid of blank cards on a cold
  Fly machine, on a Vercel preview with no `VITE_GAME_SERVER_URL`, and for any contributor
  who has no game account at all (several in `CONTRIBUTORS.md` likely don't) — whose fetch
  will 404 forever.
- A contributor **without** an account should render as a plain card with no `@username`
  and no profile link, not a broken link into a 404 profile page. Make `inGameUsername`
  optional in the interface for exactly this case.
- N cards means N parallel requests on mount. That's fine at 5 contributors, but it will
  be the first thing to hurt if this list grows — if it passes ~15, add a batch endpoint
  rather than fanning out. Note it now so it's a known threshold, not a surprise.

### 4.2 Route + footer wiring

- Add `'contributors'` to the `Screen` union in `App.tsx`, a `screenSuffix` case
  (`/contributors`), a `parseScreen` branch, and a render branch
  `{screen === 'contributors' && <Contributors onOpenProfile={openProfile} />}` inside
  the existing `AppShell` children block.
- **Do not** copy `Download`'s admin-only gate (`App.tsx:326-329`) — Contributors is public.
- `AppShell.tsx`'s footer (`.ds-foot-links`, line 108) gets a 4th entry next to
  Download/GitHub/Discord: a new `onContributors` prop mirroring the existing
  `onDownload` prop, wired the same way (`button` → `navigate('contributors')`).

### 4.3 Component + styling — reuse `.ds-panel` / `.ds-opt`, not `Admin.tsx`'s bespoke style

Per this session's research, "the configure page's box style" is `.ds-panel` (the
titled-card style used by `AudioSection`/`Configure`'s sections) and `.ds-opt` (the
individual card style already used for both toggle-buttons and `<a>` link-cards on
Download's "build it yourself" section) — **not** `Admin.tsx`'s one-off `.admin-card`
(different border-radius, no shared header bar, was built as its own thing).

`src/ui/Contributors.tsx`:
```tsx
<section className="ds-panel">
  <div className="ds-panel-h"><span className="ds-panel-title">Contributors</span></div>
  <div className="contributors-grid" style={{ padding: 16 }}>
    {CONTRIBUTORS.map((c) => <ContributorCard key={c.inGameUsername} {...c} onOpenProfile={onOpenProfile} />)}
  </div>
</section>
```
Each `ContributorCard` is an `.ds-opt`-styled block (new `.contributor-card` CSS
extending `.ds-opt`'s tokens — border, `--ds-block-sm` shadow, hover lift — added to
`shell.css`) laid out as: Discord avatar image (left, circular) — display name (button,
`onOpenProfile`) + `@username` underneath (both from the live `fetchProfileByUsername`
call, same `PlayerName`-shape as Leaderboard rows) — a small icon row underneath with the
Discord glyph and GitHub glyph (copy the exact inline `<svg fill="currentColor">` paths
from `src/ui/HomeMenu.tsx:78-88`, the only place these icons exist today — no icon
library in this codebase), each linking out via `c.discordUrl`/`c.githubUrl`.

Build everything from `--ds-*` tokens (per `CLAUDE.md`'s theming rule) so
`npm run contrast` stays green — check contrast on avatar-adjacent text and the icon
color against `--ds-panel` in both themes once built.

---

## Sequencing — ship these as four PRs, not one

These four asks arrived together, but they have nothing in common technically and *very*
different risk profiles. Bundling them means the whole branch waits on the one piece that
needs a main-developer deploy. Recommended order, each independently mergeable:

| # | Change | Touches | Deploy dependency |
|---|--------|---------|-------------------|
| 1 | **§3 display-name fix** | 3 client files | none — pure client wiring |
| 2 | **§2 volume sliders** | client + settings shape | none (server stores the blob opaquely) |
| 3 | **§4 Contributors page** | new client page + config | none |
| 4 | **§1 friends list** | migration + 8 endpoints + panel | **yes — blocks on your dev** |

Rationale: #1 is a confirmed user-visible bug with a known root cause and a three-line fix
— it should not sit behind a feature that needs a database migration. #2 and #3 are
client-only and land on Vercel the moment they merge. #4 is the long pole: it needs the
`.sql` written, reviewed, deployed by the main developer, *and* verified against the live
Neon DB, and it's the only one carrying real security surface (§1.2).

Splitting also keeps the friends PR reviewable. As one branch it's a migration, eight new
endpoints, a new repo layer, a new polling hook, a new panel with responsive behaviour, an
audio refactor, a page, and a bug fix — which is not a diff anyone can review carefully.

**Within #4, land the server before the client.** The endpoints can merge and deploy while
the panel is still behind a flag, so the API can be exercised with `curl` (see the security
checks below) before any UI depends on it — and per `CLAUDE.md`'s deploy discipline, a
server that's already live is the compatible direction.

## Verification

- `npm test` after any `src/sim`/`src/config.ts`/`src/audio.ts` change (audio volume
  logic doesn't touch `sim/`, but `game.ts` wiring is worth a smoke pass regardless).
- `npm run build` (tsc strict + vite) before calling anything done.
- `npm run contrast` after adding the friends-panel and Contributors CSS (new tokens/text
  pairs). The status dots are the risk: a green/red/gray dot is a *fill*, so per
  `CLAUDE.md`'s theming rule it must not invert — and the "Do Not Disturb" red must stay
  distinguishable from the offline gray for red-green colourblind users, so pair the dot
  with the text label rather than relying on hue alone.
- `npm run server:check` (tsc over `server/`) after the endpoint work.
- `npm run shiftaudit` after the panel lands — it forces `:hover`/`:active` on every
  interactive element and asserts nothing outside the element's subtree moves. The friends
  rows are new pressables in a new flex column, which is exactly the shape of change that
  audit exists to catch.
- **Resize test**: drag the window from wide to phone-width with the panel expanded and
  confirm the collapse/drawer transitions (§1.5) behave and the persisted-open pref doesn't
  fight the breakpoint.
- Manual pass via the `verify` skill (Electron) or `npm run dev`: sign in as two test
  accounts (two browser profiles), send/accept/decline a friend request, confirm status
  flips online/offline, confirm the header pill and Profile page now show the *same* name
  after an edit, drag all four volume sliders to 0/50/100 and confirm each category
  actually mutes independently (shoot SFX vs. match-start WAV vs. announcer voice), and
  click through a Contributors card into a live profile page.
### Security checks specific to the friends endpoints

Do these with two signed-in test accounts and a raw `curl`/devtools console — the UI will
not exercise them, because the UI is the honest client:

- With **A's** token, `POST /api/friends/accept` naming a request that doesn't exist
  (and one addressed to a third party) ⇒ must 404, and must NOT create a friendship.
- With **A's** token, `POST /api/friends/remove` naming two *other* users ⇒ must not
  delete their friendship.
- Unauthenticated `GET /api/friends` ⇒ 401. Authenticated ⇒ contains only A's own
  friends, and contains **no** `last_seen_at` for anyone who isn't a friend.
- `GET /api/users/search?q=%` and `q=_` ⇒ must not return the whole user table (wildcard
  escaping, §1.2), and the response must contain only `handle`/`username` — no
  `last_seen_at`, no settings, no email.
- Set B to `invisible`, then read A's `GET /api/friends` **raw** (not through the UI) ⇒
  B must appear offline in the JSON itself, not merely be hidden by the component.
- `GET /api/friends` with A's token must only ever move A's `last_seen_at` (the presence
  write is folded into this read, §1.2); confirm no query/body field can redirect it at
  another user.
- Block B as A, then have B send a request ⇒ rejected, with a message that doesn't
  disclose the block.

- **Do not run `flyctl deploy`** — once the migration file + server endpoints are
  written, stop and hand off to the user so their main developer can deploy it.
