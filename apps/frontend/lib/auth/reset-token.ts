/**
 * The password-reset token between where it arrives and the page that uses
 * it (#304). Memory only: never persisted, never in a URL, gone on a reload.
 *
 * - Web: `takeResetTokenFromUrl` runs in the app entry (`index.ts`), BEFORE
 *   expo-router loads, so the router never sees `?token=`: it cannot put it
 *   in its navigation state or write it back into the address.
 * - Native: the `ansarichat://reset-password?token=…` link reaches the page
 *   as a param, and the page hands it over here and replaces itself with a
 *   clean `/reset-password` (`app/reset-password.tsx`).
 *
 * The clean page takes the token on mount, which empties the slot.
 */
let slot: string | null = null;

export function handOverResetToken(token: string | null): void {
  slot = token?.trim() || null;
}

/** Returns the token and empties the slot. */
export function takeResetToken(): string | null {
  const token = slot;
  slot = null;
  return token;
}

/** Reads the slot without emptying it (a component's state initializer). */
export function peekResetToken(): string | null {
  return slot;
}

/**
 * On the web, at `/reset-password?token=…`: moves the token into the slot
 * and removes it from the address and the current history entry, in place
 * (`replaceState`: no new entry, no navigation, the entry's state kept).
 * Any other query parameter and the hash are kept. Does nothing elsewhere.
 */
export function takeResetTokenFromUrl(
  win: { location?: Partial<Location>; history?: Partial<History> } | undefined,
): void {
  // Defensive as well as gated (strip-reset-token.ts): React Native's global
  // `window` has no `location`/`history`, and this must never throw at boot.
  const location = win?.location;
  const history = win?.history;
  if (location?.pathname !== '/reset-password' || typeof history?.replaceState !== 'function') return;
  const params = new URLSearchParams(location.search ?? '');
  if (!params.has('token')) return;
  handOverResetToken(params.get('token'));
  params.delete('token');
  const query = params.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${query ? `?${query}` : ''}${location.hash ?? ''}`,
  );
}
