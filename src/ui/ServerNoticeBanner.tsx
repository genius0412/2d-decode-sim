import { useEffect, useState } from 'react';
import { useServerNotice, setServerNotice } from '../net/notice';

/** fixed top banner for admin server notices (scheduled restart countdown / info).
 * Mounted once at the app root so it shows over every screen. */
export function ServerNoticeBanner() {
  const notice = useServerNotice();
  const [, force] = useState(0);

  // tick once a second while a countdown is live
  useEffect(() => {
    if (!notice?.until) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [notice?.until]);

  if (!notice) return null;

  let text = notice.message;
  let restarting = false;
  if (notice.until) {
    const leftMs = notice.until - Date.now();
    if (leftMs <= -20000) {
      // the restart landed a while ago and we're still on the old socket — drop it
      setServerNotice(null);
      return null;
    }
    if (leftMs <= 0) {
      restarting = true;
      text = `${notice.message} - restarting now…`;
    } else {
      const left = Math.round(leftMs / 1000);
      const m = Math.floor(left / 60);
      const s = left % 60;
      text = `${notice.message} in ${m}:${String(s).padStart(2, '0')}`;
    }
  }

  return (
    <div className={`server-notice ${restarting ? 'urgent' : ''}`} role="status">
      <span className="server-notice-icon">⚠</span>
      {text}
    </div>
  );
}
