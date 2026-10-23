import regular from '../../assets/fonts/Kitab-Regular.ttf?inline';
import bold from '../../assets/fonts/Kitab-Bold.ttf?inline';

// A host can forbid data: font requests even when our document allows them. Binary
// FontFace sources use the bytes already in this self-contained document, without
// a URL request, external font server or change to the host's policy.
export async function loadKitab(document: Document, signal: AbortSignal): Promise<void> {
  const faces = ([[regular, '400'], [bold, '700']] as const).map(([data, weight]) => {
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), c => c.charCodeAt(0));
    return new FontFace('Kitab', bytes, {weight, style: 'normal'});
  });
  const remove = () => { for (const face of faces) document.fonts.delete(face); };
  signal.addEventListener('abort', remove, {once: true});
  try {
    await Promise.all(faces.map(face => face.load()));
    if (signal.aborted) return;
    for (const face of faces) document.fonts.add(face);
  } catch (error) {
    signal.removeEventListener('abort', remove);
    remove();
    throw error;
  }
}
