import { useSyncExternalStore } from 'react';

/**
 * What a reader is holding down, and what can be done with it.
 *
 * A module store, for the same reason the drawer is one: the press
 * happens on a message deep inside a virtualized thread, and the sheet
 * that answers it is mounted once by the root layout, above every
 * screen. Giving each message its own sheet would put a modal in every
 * row of the list for the one that is being pressed.
 */

export type MessageActionTarget = {
  /** Whose words these are — the sheet says so, and the notice does. */
  kind: 'answer' | 'question';
  /** The words themselves: what copy and share operate on. */
  text: string;
  /**
   * Hand the message over to the platform's own text selection.
   *
   * Selection is not on by default on a phone, and cannot be: a
   * selectable `<Text>` claims the long press for its own magnifier, so
   * the menu that offers this could never be opened. The message it was
   * raised from turns its own selection on when this is called.
   */
  onSelectText: () => void;
};

let target: MessageActionTarget | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => target;

function publish(next: MessageActionTarget | null) {
  target = next;
  for (const listener of listeners) listener();
}

/** A long press landed. */
export function openMessageActions(next: MessageActionTarget) {
  publish(next);
}

export function closeMessageActions() {
  if (!target) return;
  publish(null);
}

/** What the sheet is being asked to offer, or nothing. */
export function useMessageActions(): MessageActionTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
