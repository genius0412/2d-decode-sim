import type { ReactNode } from 'react';
import { APP_NAME, seasonFor, LINKS } from '../seasons';
import type { GameId } from '../games/types';
import { FriendsPanel } from './FriendsPanel';
import { FriendToasts } from './friendsContext';
import { Logo } from './Logo';
import { NavRail } from './NavRail';
import { usePresence } from './usePresence';
import type { Presence, RoomInvite } from '../net/api';

export type ShellNav = 'home' | 'play' | 'configure' | 'records' | 'profile' | 'admin';

/** ambient "who's around" chip in the top bar: a live-green dot + the online /
 * signed-in tally, with the ranked-queue depth in the tooltip. Renders nothing
 * until presence lands (server unconfigured / asleep / first poll pending). */
function PresenceChip({ p }: { p: Presence }) {
  const queued = p.queues['1v1'] + p.queues['2v2'];
  const title =
    `${p.online} connected to multiplayer · ${p.signedIn} signed in` +
    (queued ? ` · ${queued} in ranked queue (1v1 ${p.queues['1v1']}, 2v2 ${p.queues['2v2']})` : '');
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        whiteSpace: 'nowrap',
        color: 'var(--ds-mut)',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--ds-ok)',
          boxShadow: '0 0 6px var(--ds-ok)',
          flex: 'none',
        }}
      />
      <b style={{ color: 'var(--ds-ink)', fontWeight: 600 }}>{p.online}</b> online
      {p.signedIn > 0 && <span style={{ opacity: 0.7 }}>· {p.signedIn} signed in</span>}
    </span>
  );
}

/**
 * App chrome for the routed content screens. The top bar is deliberately thin —
 * brand, presence, and the auth slot — because navigation lives elsewhere:
 *
 *   HOME  (`showRail={false}`) — the destinations are the centered main menu.
 *   EVERY OTHER SCREEN         — the same destinations as a persistent left rail.
 *
 * Full-screen surfaces (the game, lobby, record run, ranked, replay) render
 * outside this shell entirely and own their own back/Esc semantics.
 */
export function AppShell({
  active,
  onNav,
  right,
  children,
  showAdmin,
  showRail = true,
  onDownload,
  onContributors,
  onChangelog,
  signedIn,
  onOpenProfile,
  onJoinInvite,
  myUserId,
  game,
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  right?: ReactNode;
  children: ReactNode;
  /** show the Admin entry (only the signed-in admin account) */
  showAdmin?: boolean;
  /** false on home, where the menu itself is the navigation */
  showRail?: boolean;
  /** Download is a footer destination, not one of the four `ShellNav` tabs */
  onDownload: () => void;
  /** Contributors, likewise a footer destination (but public, unlike Download) */
  onContributors: () => void;
  /** Changelog, likewise a footer destination (public) — replaces the old bare GitHub link */
  onChangelog: () => void;
  /** drives the friends panel: signed out it shows a sign-in prompt and never polls */
  signedIn: boolean;
  /** click-through from a friend/search row to that player's public profile */
  onOpenProfile: (username: string) => void;
  /** a friend's "Join" click on a room invite, from anywhere the panel is open */
  onJoinInvite: (invite: RoomInvite) => void;
  /** the signed-in account's own user id — drives the panel's "Recently played"
   * suggestions (opponents/teammates from recent matches you can friend) */
  myUserId?: string | null;
  /** the selected game — the footer names its season (DECODE / Chain Reaction) */
  game: GameId;
}) {
  const presence = usePresence();
  const season = seasonFor(game);
  return (
    <div className="ds-app">
      <header className="ds-bar">
        <button className="ds-mark" onClick={() => onNav('home')} aria-label={`${APP_NAME} home`}>
          <Logo size={24} />
          {APP_NAME}
        </button>
        <div className="ds-bar-right">
          {presence && <PresenceChip p={presence} />}
          {right}
        </div>
      </header>

      {showRail ? (
        <div className="ds-body">
          <NavRail active={active} onNav={onNav} showAdmin={showAdmin} />
          <main className="ds-main">{children}</main>
          <FriendsPanel
            signedIn={signedIn}
            onOpenProfile={onOpenProfile}
            onJoinInvite={onJoinInvite}
            myUserId={myUserId}
          />
        </div>
      ) : (
        <main className="ds-main ds-main-home">{children}</main>
      )}

      {/* floating friend-request / challenge notifications — menu shell only, so
          they never appear over a live match (full-screen surfaces are outside
          this shell). Inside the FriendsProvider that wraps AppShell in App. */}
      <FriendToasts onOpenProfile={onOpenProfile} onJoinInvite={onJoinInvite} />

      <footer className="ds-foot">
        <span className="ds-foot-brand">
          {APP_NAME} · {season.name} {season.years}
        </span>
        <span className="ds-foot-links">
          <button className="ds-foot-link" onClick={onDownload}>
            Download
          </button>
          <button className="ds-foot-link" onClick={onContributors}>
            Contributors
          </button>
          <button className="ds-foot-link bold" onClick={onChangelog}>
            Changes
          </button>
          <a href={LINKS.discord} target="_blank" rel="noreferrer">
            Discord
          </a>
        </span>
      </footer>
    </div>
  );
}
