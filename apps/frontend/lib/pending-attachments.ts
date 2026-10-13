import type { PickedImage } from '@/lib/attachments';

/**
 * The home screen's question travels to the thread as a route param (`q`),
 * but its images cannot: they are megabytes of base64 and must never land in
 * a URL or history entry (spec 211). They wait here instead, in memory, keyed
 * by the new conversation's id, and the thread sends them exactly once.
 *
 * In memory is the point: an image is sent for one turn and never stored, so
 * a reload that loses a pending image loses nothing the thread could still
 * have used.
 */
const pending = new Map<string, PickedImage[]>();

export function stashOpeningImages(conversationId: string, images: PickedImage[]): void {
  if (images.length > 0) pending.set(conversationId, images);
}

/**
 * The images waiting for this conversation. Reading does not consume them —
 * a render may run more than once (StrictMode, a remount mid hand-off) — so
 * the thread clears them itself once the question has actually been sent.
 */
export function peekOpeningImages(conversationId: string): PickedImage[] {
  return pending.get(conversationId) ?? [];
}

export function clearOpeningImages(conversationId: string): void {
  pending.delete(conversationId);
}
