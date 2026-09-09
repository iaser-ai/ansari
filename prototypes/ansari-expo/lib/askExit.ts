import { useSyncExternalStore } from 'react';

/**
 * Whether the home screen is playing its exit — the moment between a
 * question being sent and the thread arriving.
 *
 * The ambient palm shadow hangs on the paper, which is mounted once
 * above the screens, so the layer cannot be told about the ask by the
 * screen that is leaving. It cannot wait for the route either: the exit
 * glide runs for its own beat before the push, and a shadow that only
 * began to fade at the cut would still be fading over the first lines of
 * an answer.
 *
 * So the ask announces itself here, and the paper listens. One boolean,
 * set by the screen that starts the exit and cleared when the paper is
 * home again — the smallest thing that can carry a moment across a
 * navigation.
 */
let exiting = false;
const listeners = new Set<() => void>();

export function setAskExit(value: boolean) {
  if (exiting === value) return;
  exiting = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAskExit(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => exiting,
    // The server render is always the home screen at rest.
    () => false,
  );
}
