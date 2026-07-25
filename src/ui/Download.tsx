import { DESKTOP_BUILDS, releasesUrl, appVersion, detectOS, isMobile, OS_LABEL, type DesktopBuild } from '../download';
import { APP_NAME } from '../seasons';

/**
 * Download page — where users get the Electron desktop build of the sim (Windows
 * / macOS / Linux). Renders inside the app shell's `.ds-main`, so it returns only
 * page content. Build links point at the latest GitHub Release assets (published
 * by the release workflow on each `v*` tag). The visitor's detected OS is
 * featured first.
 */
export function Download() {
  const version = appVersion();
  const os = detectOS();

  // order builds so the visitor's platform leads
  const builds = [...DESKTOP_BUILDS].sort(
    (a, b) => (a.os === os ? -1 : 0) - (b.os === os ? -1 : 0),
  );

  const card = (build: DesktopBuild) => (
    <a className="ds-opt" key={build.label} href={build.url} download>
      <span className="ot">{build.label}</span>
      <span className="od">{build.note}</span>
      <span className="go">↓</span>
    </a>
  );

  const mobile = isMobile();
  // when we recognise the visitor's desktop OS, feature its PRIMARY build (the
  // first DESKTOP_BUILDS entry for that OS — Windows Installer / mac dmg / Linux
  // AppImage) as a one-click card at the top. `builds` still lists everything below.
  const featured = os && !mobile ? DESKTOP_BUILDS.find((b) => b.os === os) ?? null : null;
  const osName = featured ? featured.label.split(' · ')[0] : '';

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · {mobile ? 'On mobile' : 'Desktop'}</p>
      <h1 className="ds-h1">{mobile ? 'Play on your phone' : 'Download for desktop'}</h1>
      {mobile ? (
        <div className="ds-panel" style={{ marginBottom: 18 }}>
          <div className="ds-panel-h">
            <span className="ds-panel-title">Runs in your browser</span>
          </div>
          <div style={{ padding: 16 }}>
            <p className="ds-hint" style={{ margin: 0 }}>
              No download needed — DSIM plays right here in your mobile browser. For a full-screen,
              app-like experience, add it to your home screen: open your browser’s <b>Share</b> menu
              and tap <b>Add to Home Screen</b>. The desktop builds below are for Windows, macOS, and
              Linux.
            </p>
          </div>
        </div>
      ) : (
        <p className="ds-sub">The full offline sim in a native window.</p>
      )}

      {/* `.ds-dl` owns the gaps: these cards cast hard offset shadows, and headings are
          the only elements in the design system that carry their own bottom margin. */}
      <div className="ds-dl">
        <div className="ds-dl-hero">
          <div className="ds-dl-plat">
            <span className="glyph">🖥️</span>
            {os ? OS_LABEL[os] : 'Windows · macOS · Linux'}
            {os && <span className="ds-chip" style={{ marginLeft: 4 }}>your platform</span>}
          </div>
          <div className="ds-req">
            <span>≈120 MB</span>
            <span>Installer or portable</span>
            <span>{version ? version : 'latest release'}</span>
          </div>
          {featured && (
            <a className="ds-btn primary ds-dl-get" href={featured.url} download>
              Download for {osName} ↓
            </a>
          )}
        </div>

        <div className="ds-opts two">{builds.map(card)}</div>

        <a className="ds-btn ghost" href={releasesUrl()} target="_blank" rel="noreferrer">
          All releases →
        </a>
      </div>
    </>
  );
}
