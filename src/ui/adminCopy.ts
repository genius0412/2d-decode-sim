/**
 * ONE failure sentence for the whole admin console.
 *
 * There were five of them, spelled five ways across two files — `Failed - check admin
 * sign-in.` (×6), `Failed - check admin sign-in / DB.` (×2), `Failed - are you still
 * signed in as an admin?`, the same with `(and is the DB configured)`, and a lone
 * em-dashed `Failed — check admin sign-in / database.` They all mean the same thing and
 * none of them says WHICH action failed, which is the one piece of information an admin
 * working a queue of half a dozen buttons actually needs.
 *
 * So the shape is: what you were trying to do, then why it might not have happened. Two
 * sentences rather than a dash, because the dash is what the five variants disagreed
 * about and a full stop cannot be got wrong.
 *
 * A leaf module because `Admin.tsx` imports `AdminLive.tsx` and `AdminReports.tsx` —
 * exporting the string from any of the three would either cycle or pick an arbitrary
 * owner.
 */
export function adminFail(action: string): string {
  return `Couldn’t ${action}. The server or database is unreachable, or this account is no longer an admin.`;
}
