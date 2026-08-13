// Image-resize port (a true-external seam). Callers depend only on this
// interface; a Cloudflare Images adapter serves production and a fake serves
// tests. It exists so `view_image` can hand the model a viewing copy of a photo
// that is small enough to store: a tool result is persisted verbatim and
// replayed verbatim on every later turn, and a DO SQLite row holds at most 2 MB,
// so an image the model sees must be an image the row can carry.

export interface ResizedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageResizer {
  // Scales the image down so neither edge exceeds `maxEdge`, never up, and
  // re-encodes it. Throws when the input is not a decodable image.
  resize(input: {
    bytes: Uint8Array;
    maxEdge: number;
  }): Promise<ResizedImage>;
}
