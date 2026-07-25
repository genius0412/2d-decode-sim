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
    <div className="ds-panel" style={{ marginTop: 18 }}>
      <div className="ds-panel-h">
        <span className="ds-panel-title">Desktop app</span>
        {version && <span className="ds-chip">v{version}</span>}
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
        <div className="ds-opts" style={{ width: '100%' }}>
          <button className={`ds-opt ${autoCheck ? 'on' : ''}`} onClick={toggleAuto} aria-pressed={autoCheck}>
            <span className="ot">Auto-check for updates {autoCheck ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="ds-btn" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result?.updateAvailable && (
            <button className="ds-btn primary" onClick={() => void d.openDownload()}>
              Download v{result.latest} ↓
            </button>
          )}
        </div>

        {error && (
          <p className="ds-hint" style={{ margin: 0, color: 'var(--ds-danger)' }}>
            Couldn’t reach the update server. Try again later.
          </p>
        )}
        {result && !result.updateAvailable && (
          <p className="ds-hint" style={{ margin: 0, color: 'var(--ds-ok)' }}>
            You’re on the latest version.
          </p>
        )}
        {result?.updateAvailable && (
          <p className="ds-hint" style={{ margin: 0 }}>
            Version {result.latest} is available — auto-checked on launch when the toggle is on.
          </p>
        )}
      </div>
    </div>
  );
}
