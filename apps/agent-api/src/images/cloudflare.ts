// Cloudflare Images adapter for the ImageResizer port. Uses the per-Worker
// `IMAGES` binding, which takes raw bytes (no public URL needed) up to 20 MB —
// exactly Zero's MAX_FILE_BYTES, so every storable file is transformable.
//
// `fit: "scale-down"` never enlarges, so a photo already under the target comes
// back unchanged in dimensions. Output is JPEG because it is the smallest of
// the formats every model accepts.
//
// Billing: each unique combination of source image and parameters is billed
// once per calendar month, so a re-viewed photo costs nothing extra.

import type { ImageResizer, ResizedImage } from "./types";

export const RESIZE_FORMAT = "image/jpeg" as const;
export const RESIZE_QUALITY = 80;

// One-shot stream over the bytes we already hold. `Blob.stream()` would do the
// same but is typed as ReadableStream<any> in the Workers types.
const toStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export const createCloudflareImageResizer = (
  images: ImagesBinding,
): ImageResizer => ({
  async resize({ bytes, maxEdge }): Promise<ResizedImage> {
    const result = await images
      .input(toStream(bytes))
      .transform({ width: maxEdge, height: maxEdge, fit: "scale-down" })
      .output({ format: RESIZE_FORMAT, quality: RESIZE_QUALITY });
    const buffer = await result.response().arrayBuffer();
    return { bytes: new Uint8Array(buffer), mimeType: result.contentType() };
  },
});
