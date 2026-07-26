import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { adsConfigured } from './adsense';
import { authClient, authEnabled } from '../lib/authClient';
import { fetchEntitlements } from '../net/api';

/**
 * Whether ads should render right now, for this user.
 *
 * Self-contained on purpose: it reads the auth session and fetches the supporter
 * entitlement itself, so it can wrap the whole app ONCE in `main.tsx`. The game
 * screen renders outside the app shell (`App.tsx` returns it early), so a provider
 * threaded through the shell would miss exactly the surface the ad columns live on.
 *
 * FAIL CLOSED. `showAds` starts false and only becomes true once the entitlement
 * check has actually settled. Defaulting the other way would flash ads at a paying
 * supporter on every page load — the one outcome that makes the membership feel
 * broken. A free user pays for that with a beat of empty space, which is cheap.
 */
interface AdsState {
  /** render ad slots */
  showAds: boolean;
  /** does this account have an active supporter entitlement? */
  supporter: boolean;
  /** has the entitlement check finished? false ⇒ not known yet */
  checked: boolean;
}

const Ctx = createContext<AdsState>({ showAds: false, supporter: false, checked: false });

export function AdsProvider({ children }: { children: ReactNode }) {
  const session = authClient?.useSession();
  const userId = session?.data?.user?.id ?? null;

  const [supporter, setSupporter] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Nothing to ask about: auth is off in this build, or nobody is signed in.
    // Settle immediately so free users are not stuck behind a check that will
    // never resolve.
    if (!authEnabled || !userId) {
      setSupporter(false);
      setChecked(true);
      return;
    }
    let cancelled = false;
    setChecked(false);
    void fetchEntitlements().then((e) => {
      if (cancelled) return;
      setSupporter(e.supporter);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const showAds = adsConfigured() && checked && !supporter;
  return <Ctx.Provider value={{ showAds, supporter, checked }}>{children}</Ctx.Provider>;
}

/** ad gate + supporter status. Client state is UX only — the server is authority. */
export function useAds(): AdsState {
  return useContext(Ctx);
}
