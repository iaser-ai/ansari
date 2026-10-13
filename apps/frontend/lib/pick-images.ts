import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  base64Bytes,
  remainingSlots,
  type PickedImage,
} from '@/lib/attachments';

export type PickResult =
  | { kind: 'picked'; images: PickedImage[]; skipped: number }
  | { kind: 'cancelled' }
  | { kind: 'denied' };

/**
 * Let the reader choose up to the remaining number of images (spec 211), then
 * downscale each to `MAX_IMAGE_EDGE` and re-encode it as JPEG. That one step
 * bounds the upload, and also turns an iPhone's HEIC into a type apps/api
 * accepts. An image still over the API's cap afterwards is skipped and
 * counted, so the caller can say so instead of sending a request that will
 * be refused.
 */
export async function pickImages(alreadyAttached: number): Promise<PickResult> {
  const limit = remainingSlots(alreadyAttached);
  if (limit === 0) return { kind: 'cancelled' };

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { kind: 'denied' };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    // Re-encoding happens below; the picker's own pass would be a second, lossy one.
    quality: 1,
  });
  if (result.canceled) return { kind: 'cancelled' };

  const images: PickedImage[] = [];
  let skipped = 0;
  for (const asset of result.assets.slice(0, limit)) {
    const longest = Math.max(asset.width, asset.height);
    const resize =
      longest > MAX_IMAGE_EDGE
        ? [
            {
              resize:
                asset.width >= asset.height
                  ? { width: MAX_IMAGE_EDGE }
                  : { height: MAX_IMAGE_EDGE },
            },
          ]
        : [];
    const out = await manipulateAsync(asset.uri, resize, {
      compress: 0.8,
      format: SaveFormat.JPEG,
      base64: true,
    });
    if (!out.base64 || base64Bytes(out.base64) > MAX_IMAGE_BYTES) {
      skipped += 1;
      continue;
    }
    images.push({ uri: out.uri, mediaType: 'image/jpeg', base64: out.base64 });
  }
  return { kind: 'picked', images, skipped };
}
