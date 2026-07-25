import { LINKS } from './seasons';

/**
 * Desktop-build download config.
 *
 * The Electron desktop shell is produced with electron-builder and published to
 * GitHub Releases by `.github/workflows/release.yml` on every `v*` tag, for
 * Windows / macOS / Linux, under STABLE asset names (DSIM-Setup.exe,
 * DSIM-Portable.exe, DSIM-mac.dmg, DSIM-linux.AppImage). So by DEFAULT the
 * buttons point at `releases/latest/download/<asset>` — always the newest build.
 * Override any URL with Vite env (e.g. to host on a CDN):
 *   VITE_DOWNLOAD_INSTALLER_URL / VITE_DOWNLOAD_PORTABLE_URL /
 *   VITE_DOWNLOAD_MAC_URL / VITE_DOWNLOAD_LINUX_URL /
 *   VITE_DOWNLOAD_RELEASES_URL / VITE_APP_VERSION
 */

const RELEASES_PAGE = `${LINKS.repo}/releases`;
// Downloads are served from the site's OWN domain via the `/download/<asset>`
// edge-proxy (api/download.ts + the vercel.json rewrite), which streams the
// GitHub "latest release" binary through Vercel — so the browser never navigates
// to github.com / the githubusercontent CDN. Overridable per-URL with Vite env.
const DL = '/download';
const env = import.meta.env;

export type OS = 'windows' | 'mac' | 'linux';

export interface DesktopBuild {
  os: OS;
  /** platform + format label, e.g. "Windows · Installer" */
  label: string;
  /** short note (kind / arch) */
  note: string;
  /** download URL (the GitHub latest-release asset by default) */
  url: string;
}

export const DESKTOP_BUILDS: DesktopBuild[] = [
  {
    os: 'windows',
    label: 'Windows · Installer',
    note: '.exe · one-click NSIS setup',
    url: (env.VITE_DOWNLOAD_INSTALLER_URL as string | undefined) ?? `${DL}/DSIM-Setup.exe`,
  },
  {
    os: 'windows',
    label: 'Windows · Portable',
    note: '.exe · no install, run anywhere',
    url: (env.VITE_DOWNLOAD_PORTABLE_URL as string | undefined) ?? `${DL}/DSIM-Portable.exe`,
  },
  {
    os: 'mac',
    label: 'macOS · Universal',
    note: '.dmg · Apple Silicon + Intel',
    url: (env.VITE_DOWNLOAD_MAC_URL as string | undefined) ?? `${DL}/DSIM-mac.dmg`,
  },
  {
    os: 'linux',
    label: 'Linux · AppImage',
    note: '.AppImage · portable',
    url: (env.VITE_DOWNLOAD_LINUX_URL as string | undefined) ?? `${DL}/DSIM-linux.AppImage`,
  },
];

export const OS_LABEL: Record<OS, string> = {
  windows: 'Windows 10 / 11 · 64-bit',
  mac: 'macOS 11+ · Apple Silicon & Intel',
  linux: 'Linux · x86-64 AppImage',
};

export const releasesUrl = (): string =>
  (env.VITE_DOWNLOAD_RELEASES_URL as string | undefined) ?? RELEASES_PAGE;
export const appVersion = (): string | null => (env.VITE_APP_VERSION as string | undefined) ?? null;

/** a phone/tablet — there's no native mobile build, so the Download page steers
 * these visitors to the browser app + Add-to-Home-Screen instead of a desktop
 * binary. iPadOS 13+ masquerades as "Macintosh", so also treat a touch-capable
 * "mac" UA as mobile. */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  const iPadOS = /macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return /android|iphone|ipad|ipod|mobile|tablet|silk|kindle/.test(ua) || iPadOS;
}

/** best-guess the visitor's OS so its build can be featured first */
export function detectOS(): OS | null {
  if (typeof navigator === 'undefined') return null;
  const s = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('mac') || s.includes('iphone') || s.includes('ipad')) return 'mac';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  return null;
}
