// Typed access to the Electron preload bridge (electron/preload.cjs). Present only
// when running inside the desktop app; `null` in a normal browser, so callers can
// hide desktop-only UI (version readout, update controls) on the web.
export interface DesktopBridge {
  isDesktop: true;
  version(): Promise<string>;
  check(): Promise<{ current: string; latest: string | null; updateAvailable: boolean }>;
  getAutoCheck(): Promise<boolean>;
  setAutoCheck(v: boolean): Promise<boolean>;
  openDownload(): Promise<void>;
}

declare global {
  interface Window {
    dsim?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | null =>
  typeof window !== 'undefined' && window.dsim?.isDesktop ? window.dsim : null;
