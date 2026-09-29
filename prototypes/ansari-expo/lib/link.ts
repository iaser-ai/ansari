import { Linking, Platform } from 'react-native';
import { safeHref } from '@/lib/markdown';
import { showNotice } from '@/lib/notice';

/**
 * Open a link from an answer, outside the app.
 *
 * An answer's links go to scripture and scholarship on other people's
 * sites, so they leave: the reader's browser, with its own address bar
 * and their own session, rather than a chromeless in-app webview that
 * hides where they have landed.
 *
 * The destination is re-checked here even though the parser already
 * refused anything that is not a plain web address. The parser's job is
 * to describe the text; this is the last gate before the URL reaches
 * the platform, and it costs one regex.
 */
export async function openExternalLink(href: string): Promise<void> {
  const safe = safeHref(href);
  if (!safe) return;

  if (Platform.OS === 'web') {
    // `noopener` also implies `noreferrer` in practice, but both are
    // named: the new tab must not get a handle on this one.
    window.open(safe, '_blank', 'noopener,noreferrer');
    return;
  }

  try {
    await Linking.openURL(safe);
  } catch {
    showNotice('Link could not be opened', safe);
  }
}

/**
 * A plain email address, checked here rather than trusted from the call
 * site — the same last gate `openExternalLink` applies to a URL, for the
 * one other scheme the app hands to the platform.
 *
 * `mailto:` is deliberately outside `safeHref`: an answer's links come
 * from a model and are held to web addresses only. An address written
 * into the app's own pages is a different thing, and a reader who taps
 * one expects their mail client, not a copyable string.
 */
export async function openEmail(address: string): Promise<void> {
  const trimmed = address.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(trimmed)) return;
  const href = `mailto:${trimmed}`;

  if (Platform.OS === 'web') {
    window.location.href = href;
    return;
  }

  try {
    await Linking.openURL(href);
  } catch {
    showNotice('No mail app is set up', trimmed);
  }
}
