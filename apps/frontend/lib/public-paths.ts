import { isSharePath } from '@/lib/share-link';

/**
 * The pages that need no identity: a shared thread (`isSharePath`), the two
 * halves of a password reset (#304), and account deletion (#306: the address
 * listed with the app stores, so a store reviewer or a mailed link arrives
 * with nothing stored). Each renders while the session is
 * still being restored, shows no rail and no account chrome (they are the
 * viewer's own threads and identity), and must NOT provision a guest: a
 * link opened in a fresh browser, a private window, a webmail's
 * in-app browser or a link scanner would otherwise spend one of the three
 * sign-ups per minute on every click. Leaving the page releases the held
 * guest (`AuthProvider` `deferGuest`).
 */
export const ACCOUNT_PATHS = ['/forgot-password', '/reset-password', '/delete-account'] as const;

export function isPublicPath(path: string): boolean {
  return isSharePath(path) || (ACCOUNT_PATHS as readonly string[]).includes(path);
}
