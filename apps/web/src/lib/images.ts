/**
 * Images added to an answer or a document, made ready for the API, which
 * keeps PNG, JPEG, GIF and WebP up to 10 MB (apps/api/src/answers.ts).
 * Anything else the browser can open (a HEIC photo in Safari, a BMP), and a
 * photo too big, goes as a JPEG of at most 3200 pixels a side.
 */

const KEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 3200;

/** Whether a file is an image (a HEIC photo can come without a type). */
export const isImage = (file: File) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);

export async function prepareImage(file: Blob): Promise<Blob> {
  if (KEPT.includes(file.type) && file.size <= MAX_BYTES) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be opened. Add a PNG, JPEG, GIF or WebP image.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The image could not be added.');
  // A JPEG has no transparency: what was clear prints as the page does, white.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!jpeg) throw new Error('The image could not be added.');
  return jpeg;
}
