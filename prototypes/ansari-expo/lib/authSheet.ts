import { useSyncExternalStore } from 'react';

/**
 * Whether the sign-in sheet is up, and which face it is showing.
 *
 * A module store, for the same reason the message actions are one: the
 * sheet is mounted once by the root layout, above every screen, and the
 * ways into it — the account corner, the rail's footer, the `/login` and
 * `/register` links — are scattered across the tree with no common
 * parent short of the root.
 */

export type AuthMode = 'login' | 'register';

let mode: AuthMode | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => mode;

function publish(next: AuthMode | null) {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

/** Raise the sheet on the given face. */
export function openAuthSheet(next: AuthMode) {
  publish(next);
}

/**
 * Turn the open sheet to its other face — "Log in" ↔ "Sign up" — without
 * putting it away. Does nothing if the sheet is not up.
 */
export function setAuthSheetMode(next: AuthMode) {
  if (!mode) return;
  publish(next);
}

export function closeAuthSheet() {
  publish(null);
}

/** The face the sheet is showing, or nothing while it is put away. */
export function useAuthSheet(): AuthMode | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
