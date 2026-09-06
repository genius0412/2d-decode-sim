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
        // no inline margin: `.ds-main > .ds-panel` owns the panel stack now.
        <div className="ds-panel">
          <div className="ds-panel-h">
            <span className="ds-panel-title">Runs in your browser</span>
          </div>
          <div className="ds-panel-body">
            {/* one sentence — the one the reader can act on. "No download needed.
                DSIM runs in your mobile browser" restated the panel title, and
                "The desktop builds below are for Windows, macOS, and Linux"
                described the section directly beneath it, which is already headed
                by its own platform labels. */}
            <p className="ds-hint">
              To run full-screen, open your browser’s <b>Share</b> menu and tap{' '}
              <b>Add to Home Screen</b>.
            </p>
          </div>
        </div>
      ) : (
        <p className="ds-sub">The full offline sim in a native window.</p>
      )}

      {/* `.ds-dl` owns the gaps: these cards cast hard offset shadows, and headings are
          the only elements in the design system that carry their own bottom margin. */}
      <div className="ds-dlpage">
        <div className="ds-dl-hero">
          {/* No 🖥️ and no "your platform" chip. The emoji is the only element on
              this page rendered in the OS font — it ignores the theme and
              `currentColor` and looks different per platform — decorating a line
              that already NAMES the platform. And the chip was a third signal for
              one fact: the line prints the detected OS, the button below reads
              "Download for Windows ↓", and the build list is sorted to put it
              first. */}
          <div className="ds-dl-plat">{os ? OS_LABEL[os] : 'Windows · macOS · Linux'}</div>
          <div className="ds-req">
            {/* "Installer or portable" was a caption restating the labels of the
                cards 40px below it ("Windows · Installer", "Windows · Portable"). */}
            <span>≈120 MB</span>
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
