import { useEffect, useState } from 'react';
import { desktop } from '../desktop';

/**
 * Desktop-app panel: build version, a manual "Check for updates" button, and an
 * "auto-check" toggle. Renders nothing on the web (no `window.dsim`). Actual
 * install is a one-click trip to the download page — silent auto-install needs a
 * code-signed macOS build, which this unsigned build can't do.
 */
export function DesktopUpdate() {
  const d = desktop();
  const [version, setVersion] = useState<string | null>(null);
  const [autoCheck, setAutoCheck] = useState(true);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ latest: string | null; updateAvailable: boolean } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!d) return;
    d.version().then(setVersion).catch(() => {});
    d.getAutoCheck().then(setAutoCheck).catch(() => {});
  }, [d]);

  if (!d) return null; // browser / non-desktop

  const check = (): void => {
    setChecking(true);
    setError(false);
    setResult(null);
    d.check()
      .then(setResult)
      .catch(() => setError(true))
      .finally(() => setChecking(false));
  };

  const toggleAuto = (): void => {
    const next = !autoCheck;
    setAutoCheck(next);
    d.setAutoCheck(next)
      .then(setAutoCheck)
      .catch(() => setAutoCheck(!next));
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Desktop app</span>
        {version && <span className="ds-chip">v{version}</span>}
      </div>
      {/* `.ds-panel-body.stack` — the four properties written out here
          inline (padding 16, flex column, gap 12, align flex-start) are the same
          four retyped in half a dozen other panel bodies. */}
      <div className="ds-panel-body stack">
        <div className="ds-opts">
          <button className={`ds-opt ${autoCheck ? 'on' : ''}`} onClick={toggleAuto} aria-pressed={autoCheck}>
            <span className="ot">Auto-check for updates {autoCheck ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* `.ds-actions` already IS this row (flex, wrap, centred) — no need for a
            fourth hand-written copy of it. */}
        <div className="ds-actions">
          <button className="ds-btn" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result?.updateAvailable && (
            <button className="ds-btn primary" onClick={() => void d.openDownload()}>
              Download v{result.latest} ↓
            </button>
          )}
        </div>

        {/* the colour is a CLASS. `.ds-hint` is already `margin: 0`, so both inline
            `margin: 0` were no-ops kept alive next to a colour literal — and
            `.ds-claim-msg.ok/.err` already exist for exactly this status pair. */}
        {error && <p className="ds-hint err">Couldn’t reach the update server. Try again.</p>}
        {result && !result.updateAvailable && (
          <p className="ds-hint ok">You’re on the latest version.</p>
        )}
      </div>
    </div>
  );
}
