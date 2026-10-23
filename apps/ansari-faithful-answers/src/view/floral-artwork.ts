// The approved 8 October floral artwork, supplied to the theme stylesheet as CSS custom properties.
// The bytes are the application's own trusted assets (assets/): constants fixed at
// build time. Nothing here reads an answer, a tool result or host context, so no delivered value can
// select, replace or reference artwork. Light and dark are separate artwork, never a filter of one.
import {answerAssets} from '../../assets/answer-assets.js';
import {ansariBrandMark} from '../../assets/brand-mark.js';

type Style = {setProperty(name: string, value: string): void};

const url = (dataUrl: string): string => `url("${dataUrl}")`;

/** Every property the theme stylesheet reads, with the asset it carries. */
export function artworkProperties(): Record<string, string> {
  const properties: Record<string, string> = {'--ansari-art-brand-mark': url(ansariBrandMark)};
  for (const appearance of ['light', 'dark'] as const) {
    for (const part of ['flourish', 'marker', 'separator'] as const) {
      properties[`--ansari-art-${appearance}-${part}`] = url(answerAssets[appearance][part]);
    }
  }
  return properties;
}

/** Declares the artwork on the view's root element once, before an answer is shown. */
export function installFloralArtwork(root: {style: Style}): void {
  for (const [name, value] of Object.entries(artworkProperties())) root.style.setProperty(name, value);
}
