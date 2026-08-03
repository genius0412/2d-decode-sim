import { useState, type ReactNode } from 'react';
import { cmpEnabled, showConsentSettings } from '../ads/adsense';
import { APP_NAME, seasonFor, LINKS } from '../seasons';
import { SUPPORT_ENABLED } from '../net/env';
import type { GameId } from '../games/types';
import { MenuAd } from './AdSlot';
import { FriendsPanel } from './FriendsPanel';
import { FriendToasts } from './friendsContext';
import { Logo } from './Logo';
import { NavRail } from './NavRail';
import { usePresence } from './usePresence';
import { MaintenanceBanner } from './MaintenanceBanner';
import { PresenceProvider, QueueCounts } from './QueueCounts';
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
  onPrivacy,
  onTerms,
  onDonate,
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
  /** Privacy policy — public, and a hard prerequisite for the AdSense application */
  onPrivacy: () => void;
  /** Terms of use — public, paired with the privacy policy */
  onTerms: () => void;
  /** Support/donate page — Ko-fi link + the supporter-membership claim flow */
  onDonate: () => void;
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
    // ONE poller for the whole shell — every menu that shows queue depth reads this
    // value rather than starting its own (see QueueCounts.tsx)
    <PresenceProvider value={presence} game={game}>
    <div className="ds-app">
      <header className="ds-bar">
        <button className="ds-mark" onClick={() => onNav('home')} aria-label={`${APP_NAME} home`}>
          <Logo size={24} />
          {APP_NAME}
        </button>
        <div className="ds-bar-right">
          {/* the header is on EVERY menu screen, so this is the one placement that
              makes queue depth visible everywhere rather than only where someone
              already went looking for a match */}
          <QueueCounts className="bar" allGames />
          {presence && <PresenceChip p={presence} />}
          {right}
        </div>
      </header>
      {/* the maintenance window, on every menu screen. Fed by the presence poll
          rather than the socket so it also reaches the screens that hold no
          connection — which is exactly where somebody stands when they are about to
          start the thing we need them not to start. */}
      <MaintenanceBanner presence={presence} />

      {showRail ? (
        <div className="ds-body">
          <NavRail active={active} onNav={onNav} showAdmin={showAdmin} />
          <main className="ds-main">
            {children}
            {/* The SAFE ad inventory: a shell page is not a gameplay page, so
                there is no clearance rule and no frame budget to protect. It
                sits BELOW the page content, after the thing the visitor came
                for — an ad above the leaderboard would be the interstitial
                pattern AdSense's own policies discourage. */}
            <MenuAd />
          </main>
          <FriendsPanel
            signedIn={signedIn}
            onOpenProfile={onOpenProfile}
            onJoinInvite={onJoinInvite}
            myUserId={myUserId}
          />
        </div>
      ) : (
        // The home screen deliberately gets NO ad. It is the first thing a new
        // visitor sees and the page an AdSense reviewer lands on; it should read
        // as a product, not as inventory.
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
          {/* hidden until the tier is actually open for business - see
              SUPPORT_ENABLED. A link to a page that cannot take a payment is a
              dead end, and a broken purchase path is a cited AdSense rejection. */}
          {SUPPORT_ENABLED && (
            <button className="ds-foot-link" onClick={onDonate}>
              Support
            </button>
          )}
          <button className="ds-foot-link" onClick={onPrivacy}>
            Privacy
          </button>
          <button className="ds-foot-link" onClick={onTerms}>
            Terms
          </button>
          <ConsentLink />
          {/* main replaced the bare GitHub link with Changes — keep that, plus
              monetization's Support/Privacy/Terms destinations */}
          <button className="ds-foot-link bold" onClick={onChangelog}>
            Changes
          </button>
          <a href={LINKS.discord} target="_blank" rel="noreferrer">
            Discord
          </a>
        </span>
      </footer>
    </div>
    </PresenceProvider>
  );
}

/**
 * "Privacy & cookie settings" — reopens the consent message.
 *
 * Required rather than a nicety: consent that cannot be withdrawn as easily as
 * it was given is not valid consent, and the privacy policy points at this exact
 * link by name, so it has to exist wherever that policy is served.
 *
 * Rendered only when the build actually ships a CMP (`cmpEnabled`), and it
 * disappears if the message cannot be opened — which is the normal case outside
 * the EEA/UK/CH, where there is no consent dialog to reopen. A footer link that
 * silently does nothing is worse than no link.
 */
function ConsentLink() {
  const [gone, setGone] = useState(false);
  if (!cmpEnabled() || gone) return null;
  return (
    <button
      className="ds-foot-link"
      onClick={() => {
        if (!showConsentSettings()) setGone(true);
      }}
    >
      Privacy &amp; cookie settings
    </button>
  );
}
