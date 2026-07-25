import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchUserMatches,
  searchUsers,
  type FriendRow,
  type MatchHistoryEntry,
  type PresenceStatus,
  type PublicProfile,
  type RoomInvite,
} from '../net/api';
import type { FriendsApi } from './useFriends';
import { useFriendsCtx } from './friendsContext';
import { Select, type SelectOption } from './Select';

/** compact game name for an activity line ("In a match · DECODE") */
function gameShort(game: 'decode' | 'chain' | null): string {
  return game === 'chain' ? 'Chain' : game === 'decode' ? 'DECODE' : '';
}

/** the chess.com-style activity line for an ONLINE friend: what they're doing,
 * not just "Online". DND wins (they asked not to be shown as available). */
function presenceLine(f: FriendRow): string {
  if (f.status === 'dnd') return 'Do not disturb';
  const g = gameShort(f.game);
  if (f.activity === 'match') return g ? `In a match · ${g}` : 'In a match';
  if (f.activity === 'lobby') return g ? `In a lobby · ${g}` : 'In a lobby';
  return 'Online';
}

/** may this online friend be challenged right now? Not while DND (asked not to be
 * disturbed) or mid-match (busy — the invite would just pile up unseen). */
function canChallenge(f: FriendRow): boolean {
  return f.online && f.status !== 'dnd' && f.activity !== 'match' && !!f.username;
}

const OPEN_KEY = 'decodesim.friendsPanelOpen';

/**
 * Between these widths there is room for the left rail and the content, but not
 * for an expanded friends panel too — so the panel force-collapses to its icon
 * rail. Below 900px `.ds-body` turns into a column (see shell.css) and the panel
 * becomes a full-width strip, where being expanded is fine again.
 *
 * This is a CONSTRAINT, not a preference: the stored open/closed choice is left
 * untouched, so widening the window restores whatever the player had. Storing
 * "open" on a desktop must never produce a panel that eats a laptop screen.
 */
const SQUEEZE = '(max-width: 1100px) and (min-width: 901px)';

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof matchMedia === 'function' ? matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** "just now" / "5m" / "3h" / "2d" — the server already rounds to these buckets,
 * so this only has to pick a unit. */
function offlineFor(seconds: number | null): string {
  if (seconds === null) return 'Offline';
  if (seconds < 60) return 'Offline · just now';
  if (seconds < 3600) return `Offline for ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `Offline for ${Math.round(seconds / 3600)}h`;
  return `Offline for ${Math.round(seconds / 86400)}d`;
}

/**
 * The friends list: a structural twin of `NavRail`, mirrored to the right edge.
 * A flex sibling inside `.ds-body`, never `position: fixed` — `.ds-app` is the
 * app's only scroll container, and a fixed panel would scroll independently of it.
 *
 * Collapsed by default: a new account has no friends, so an expanded panel would
 * be a column of empty state on every screen. The incoming-request badge on the
 * collapsed rail is what earns the expand — without it a request would be
 * invisible until someone happened to open the panel, and the feature would
 * quietly not work.
 */
export function FriendsPanel({
  signedIn,
  onOpenProfile,
  onJoinInvite,
  myUserId,
}: {
  signedIn: boolean;
  onOpenProfile: (username: string) => void;
  /** a friend invited you to a room and you clicked Join */
  onJoinInvite: (invite: RoomInvite) => void;
  /** the signed-in account's user id — drives "Recently played" suggestions */
  myUserId?: string | null;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const squeezed = useMediaQuery(SQUEEZE);
  const expanded = open && !squeezed;

  const toggle = (): void => {
    const next = !expanded;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* private mode — the panel still works, it just won't remember */
    }
  };

  const friends = useFriendsCtx();
  const { incoming, outgoing, blocked, invites, friends: list } = friends.data;
  const waiting = incoming.length + invites.length;

  const [online, offline] = useMemo(() => {
    const on: FriendRow[] = [];
    const off: FriendRow[] = [];
    for (const f of list) (f.online ? on : off).push(f);
    return [on, off];
  }, [list]);

  if (!expanded) {
    return (
      <aside className="ds-friends collapsed" aria-label="Friends">
        <button
          className="fr-toggle"
          onClick={toggle}
          title={squeezed ? 'Friends (needs a wider window to stay open)' : 'Show friends'}
          aria-expanded={false}
        >
          <PeopleGlyph />
          {waiting > 0 && (
            <span className="fr-badge" aria-label={`${waiting} friend requests and invites`}>
              {waiting}
            </span>
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="ds-friends" aria-label="Friends">
      <div className="fr-head">
        <span className="fr-title">Friends</span>
        <button className="fr-collapse" onClick={toggle} aria-expanded title="Hide friends">
          ✕
        </button>
      </div>

      {!signedIn ? (
        <p className="fr-empty">Sign in to add friends and see who’s online.</p>
      ) : friends.unavailable ? (
        // the server predates this client build (one Fly app serves every client
        // version) — a plain explanation, never an error boundary
        <p className="fr-empty">Friends aren’t available on this server yet.</p>
      ) : (
        <>
          <StatusPicker value={friends.data.status} onChange={friends.setStatus} />

          {friends.error && <p className="fr-error">{friends.error}</p>}

          {invites.length > 0 && (
            <Section title="Invites" count={invites.length}>
              {invites.map((inv) => (
                <div className="fr-row" key={inv.id}>
                  <span className="fr-who static">
                    <span className="fr-name">{inv.from.handle}</span>
                    <span className="fr-sub">invited you to a room</span>
                  </span>
                  <span className="fr-actions">
                    <button className="ds-btn small primary" onClick={() => onJoinInvite(inv)}>
                      Join
                    </button>
                    <button className="ds-btn small ghost" onClick={() => void friends.dismissInvite(inv.id)}>
                      Dismiss
                    </button>
                  </span>
                </div>
              ))}
            </Section>
          )}

          {incoming.length > 0 && (
            <Section title="Requests" count={incoming.length}>
              {incoming.map((p) => (
                <Row key={p.userId} p={p} onOpenProfile={onOpenProfile}>
                  <button
                    className="ds-btn small primary"
                    onClick={() => void friends.accept(p.username ?? '')}
                  >
                    Accept
                  </button>
                  <button
                    className="ds-btn small ghost"
                    onClick={() => void friends.decline(p.username ?? '')}
                  >
                    Decline
                  </button>
                </Row>
              ))}
            </Section>
          )}

          <Section title="Online" count={online.length}>
            {online.length === 0 ? (
              <p className="fr-empty">Nobody’s online right now.</p>
            ) : (
              online.map((f) => (
                // the status is spelled out in the sub-line, not carried by the
                // dot's hue alone: a red DND dot and a green online dot are the
                // same dot to a red-green colourblind player. The @username stays
                // reachable via the row's title and the click-through.
                <Row key={f.userId} p={f} onOpenProfile={onOpenProfile} sub={presenceLine(f)}>
                  <span
                    className={`fr-dot${f.status === 'dnd' ? ' dnd' : f.activity === 'match' || f.activity === 'lobby' ? ' busy' : ''}`}
                    aria-hidden
                  />
                  {canChallenge(f) && f.username && (
                    <ChallengeButton username={f.username} onChallenge={friends.openChallenge} />
                  )}
                  <RowMenu username={f.username} friends={friends} />
                </Row>
              ))
            )}
          </Section>

          {offline.length > 0 && (
            <Section title="Offline" count={offline.length}>
              {offline.map((f) => (
                <Row key={f.userId} p={f} onOpenProfile={onOpenProfile} sub={offlineFor(f.offlineSeconds)}>
                  <RowMenu username={f.username} friends={friends} />
                </Row>
              ))}
            </Section>
          )}

          {outgoing.length > 0 && (
            <Section title="Sent" count={outgoing.length}>
              {outgoing.map((p) => (
                <Row key={p.userId} p={p} onOpenProfile={onOpenProfile}>
                  <button
                    className="ds-btn small ghost"
                    onClick={() => void friends.cancel(p.username ?? '')}
                  >
                    Cancel
                  </button>
                </Row>
              ))}
            </Section>
          )}

          {/* ALWAYS rendered, unlike Requests/Sent above. Those are transient — an
              absent one means nothing is pending. This is a standing setting: hiding
              it when empty leaves no way to answer "have I blocked anyone?", and a
              blocked player is invisible everywhere else by definition, so the fold
              is the only place they exist in the UI. It's collapsed, so an empty one
              costs a single header line. */}
          <FoldSection title="Blocked" count={blocked.length}>
            {blocked.map((p) => (
              <Row key={p.userId} p={p} onOpenProfile={onOpenProfile}>
                <button
                  className="ds-btn small ghost"
                  // A blocked row can only exist if you named that account by
                  // username to block it, so this is unreachable — but sending
                  // '' would ask the server to look up the empty string, which
                  // is how `accept` used to fail with an opaque error.
                  disabled={!p.username}
                  onClick={() => {
                    if (p.username) void friends.unblock(p.username);
                  }}
                >
                  Unblock
                </button>
              </Row>
            ))}
            <p className="fr-empty">
              {blocked.length === 0
                ? 'You haven’t blocked anyone. Blocked players can’t send you friend requests, and you won’t appear in their friends list.'
                : 'Blocked players can’t send you friend requests, and you won’t appear in their friends list.'}
            </p>
          </FoldSection>

          <RecentlyPlayed
            myUserId={myUserId}
            known={friends.data}
            onAdd={friends.add}
            onOpenProfile={onOpenProfile}
          />

          <AddFriend onAdd={friends.add} known={friends.data} />
        </>
      )}
    </aside>
  );
}

/** the non-self players with a public username from a page of match history,
 * deduped, freshest-first — everyone you've recently shared a match with. */
function recentPeople(rows: MatchHistoryEntry[], myUserId: string): PublicProfile[] {
  const seen = new Set<string>([myUserId]);
  const out: PublicProfile[] = [];
  for (const row of rows) {
    for (const p of row.players) {
      if (seen.has(p.userId) || !p.username) continue; // no username ⇒ can't friend them
      seen.add(p.userId);
      out.push({ userId: p.userId, handle: p.handle, username: p.username });
    }
  }
  return out;
}

/**
 * "Recently played": opponents and teammates from your recent matches you aren't
 * already connected to, each one-click friendable. chess.com's "add the person you
 * just played" — the highest-intent moment to send a request — surfaced as a
 * standing list so it isn't lost the instant the results screen closes. Renders
 * nothing until there's at least one addable person (a new/solo player sees no
 * empty section).
 */
function RecentlyPlayed({
  myUserId,
  known,
  onAdd,
  onOpenProfile,
}: {
  myUserId?: string | null;
  known: { friends: FriendRow[]; incoming: PublicProfile[]; outgoing: PublicProfile[]; blocked: PublicProfile[] };
  onAdd: (username: string) => Promise<'sent' | 'accepted'>;
  onOpenProfile: (username: string) => void;
}) {
  const [people, setPeople] = useState<PublicProfile[]>([]);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!myUserId) {
      setPeople([]);
      return;
    }
    let alive = true;
    // a page of recent matches is plenty — recentPeople dedupes to the handful of
    // distinct people in them. Silent on failure (server asleep/older): the
    // section just doesn't appear.
    void fetchUserMatches(myUserId, { limit: 25 })
      .then((page) => {
        if (alive) setPeople(recentPeople(page.rows, myUserId));
      })
      .catch(() => {
        if (alive) setPeople([]);
      });
    return () => {
      alive = false;
    };
  }, [myUserId]);

  // hide anyone already a friend / pending either direction / blocked — the only
  // ones worth suggesting are people you have no relationship with yet
  const connected = useMemo(() => {
    const s = new Set<string>();
    for (const f of known.friends) if (f.username) s.add(f.username);
    for (const p of [...known.incoming, ...known.outgoing, ...known.blocked]) if (p.username) s.add(p.username);
    return s;
  }, [known]);

  const suggestions = people.filter((p) => p.username && !connected.has(p.username)).slice(0, 6);
  if (suggestions.length === 0) return null;

  return (
    <section className="fr-section">
      <h3 className="fr-sec-h">Recently played</h3>
      {suggestions.map((p) => (
        <Row key={p.userId} p={p} onOpenProfile={onOpenProfile}>
          <button
            className="ds-btn small"
            disabled={!!(p.username && added[p.username])}
            onClick={() => {
              const u = p.username;
              if (!u) return;
              void onAdd(u)
                .then(() => setAdded((m) => ({ ...m, [u]: true })))
                .catch(() => {
                  /* the hook surfaces the message in friends.error */
                });
            }}
          >
            {p.username && added[p.username] ? 'Added' : 'Add'}
          </button>
        </Row>
      ))}
    </section>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="fr-section">
      <h3 className="fr-sec-h">
        {title} <span className="fr-sec-n">{count}</span>
      </h3>
      {children}
    </section>
  );
}

/**
 * A section that starts FOLDED. Used for the blocked list: it's something you go
 * looking for once in a while, not something to keep in view. Rendering it open
 * would hand the people you muted permanent real estate in a panel that is
 * otherwise entirely about people you want to see — while still leaving them
 * reachable, which an unblock flow buried in a settings page would not.
 */
function FoldSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    // NOT `.fr-section` — that is `display: flex`, and a flex <details> has a
    // history of leaking its closed content in some engines. Plain block box,
    // with the column layout on an inner wrapper instead.
    <details className="fr-fold">
      <summary className="fr-sec-h">
        {title} <span className="fr-sec-n">{count}</span>
      </summary>
      <div className="fr-fold-body">{children}</div>
    </details>
  );
}

/** handle + @username, both clicking through to the profile — the same shape
 * `Leaderboard`'s player cell uses, so every friend/request/result row behaves
 * identically to a name anywhere else in the app. */
function Row({
  p,
  sub,
  onOpenProfile,
  children,
}: {
  p: PublicProfile | FriendRow;
  sub?: string;
  onOpenProfile: (username: string) => void;
  children?: React.ReactNode;
}) {
  const username = p.username;
  const open = (): void => {
    if (username) onOpenProfile(username);
  };
  return (
    <div className="fr-row">
      <button className="fr-who" onClick={open} disabled={!username} title={username ? `View @${username}` : undefined}>
        <span className="fr-name">{p.handle}</span>
        <span className="fr-sub">{sub ?? (username ? `@${username}` : '')}</span>
      </button>
      <span className="fr-actions">{children}</span>
    </div>
  );
}

/** the chess.com "play a friend" affordance: opens the format picker (1v1 / 2v2 /
 * co-op record). The picker itself sends the invite + hosts the room. */
function ChallengeButton({
  username,
  onChallenge,
}: {
  username: string;
  onChallenge: (username: string) => void;
}) {
  return (
    <button
      className="ds-btn small primary fr-challenge"
      title={`Challenge @${username} to a match`}
      onClick={() => onChallenge(username)}
    >
      Challenge
    </button>
  );
}

/** unfriend / block, tucked behind a details disclosure so a destructive action
 * is never one stray click away in a dense list */
function RowMenu({
  username,
  friends,
}: {
  username: string | null;
  friends: FriendsApi;
}) {
  if (!username) return null;
  return (
    <details className="fr-menu">
      <summary aria-label="More">⋯</summary>
      <div className="fr-menu-body">
        <button className="ds-btn small ghost" onClick={() => void friends.unfriend(username)}>
          Unfriend
        </button>
        <button className="ds-btn small ghost" onClick={() => void friends.block(username)}>
          Block
        </button>
      </div>
    </details>
  );
}

type StatusChoice = 'auto' | PresenceStatus;
const STATUS_OPTIONS: SelectOption<StatusChoice>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'dnd', label: 'Do not disturb' },
  { value: 'invisible', label: 'Invisible' },
];

function StatusPicker({
  value,
  onChange,
}: {
  value: PresenceStatus | null;
  onChange: (s: PresenceStatus | null) => Promise<void>;
}) {
  return (
    <div className="fr-status">
      <span className="cap">Status</span>
      <Select
        ariaLabel="Status"
        value={value ?? 'auto'}
        options={STATUS_OPTIONS}
        onChange={(v) => void onChange(v === 'auto' ? null : v)}
      />
    </div>
  );
}

/**
 * Username search + send request. Debounced ~250ms and sequence-guarded: every
 * keystroke would otherwise fire a request at a machine that may be cold-starting,
 * and a slow early response could overwrite the results for a longer query.
 */
function AddFriend({
  onAdd,
  known,
}: {
  onAdd: (username: string) => Promise<'sent' | 'accepted'>;
  known: { friends: FriendRow[]; outgoing: PublicProfile[] };
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicProfile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      void searchUsers(q).then((users) => {
        // a stale response from a shorter query must not clobber a newer one
        if (seq.current === mine) setResults(users);
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const already = (u: string | null): boolean =>
    !!u && (known.friends.some((f) => f.username === u) || known.outgoing.some((p) => p.username === u));

  return (
    <section className="fr-section">
      <h3 className="fr-sec-h">Add a friend</h3>
      <input
        className="ds-input"
        value={query}
        placeholder="Search username…"
        aria-label="Search for a player by username"
        onChange={(e) => {
          setQuery(e.target.value);
          setNote(null);
        }}
      />
      {note && <p className="fr-note">{note}</p>}
      {results.map((p) => (
        <div className="fr-row" key={p.userId}>
          <span className="fr-who static">
            <span className="fr-name">{p.handle}</span>
            <span className="fr-sub">@{p.username}</span>
          </span>
          <span className="fr-actions">
            <button
              className="ds-btn small"
              disabled={already(p.username)}
              onClick={() => {
                const u = p.username;
                if (!u) return;
                void onAdd(u)
                  .then((outcome) =>
                    setNote(
                      outcome === 'accepted'
                        ? `You and ${p.handle} are now friends.`
                        : `Request sent to ${p.handle}.`,
                    ),
                  )
                  .catch(() => {
                    /* the hook surfaces the message in friends.error */
                  });
              }}
            >
              {already(p.username) ? 'Added' : 'Add'}
            </button>
          </span>
        </div>
      ))}
      {query.trim().length >= 2 && results.length === 0 && (
        <p className="fr-empty">No players found.</p>
      )}
    </section>
  );
}

function PeopleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 1a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V20h7v-2.5c0-.98.5-1.86 1.3-2.55A11.6 11.6 0 0 0 8 14Zm8 0c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z" />
    </svg>
  );
}
