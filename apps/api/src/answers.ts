import type { Env } from './env';
import { ensureServerSchema, readLimited } from './service';
import { BadRequest, NotFound, Surreal, recordId, toBase64 } from './surreal';

/**
 * Images pasted into a homework answer: a sketch, a photo of a drawing. Kept
 * in the `materials` bucket and served by an unguessable id, like the images
 * of a lecture (an <img> cannot send the session token).
 */

export const MAX_ANSWER_IMAGE_BYTES = 10 * 1024 * 1024;

const TYPES: { mime: string; magic: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/webp', magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 },
];

/** Stores an image for one of the user's answers. Answers `answer_image:<id>`. */
export async function storeAnswerImage(env: Env, userId: string, answerId: string, body: ReadableStream<Uint8Array> | null): Promise<string> {
  const answer = recordId('answer', answerId);
  await ensureServerSchema(env);
  const db = Surreal.system(env);
  const owned = await db.query<string | null>(
    'RETURN (SELECT VALUE id FROM type::record($answer) WHERE owner = type::record($owner))[0]',
    { answer, owner: userId },
  );
  if (!owned) throw new NotFound('Answer not found.');
  const bytes = await readLimited(body, MAX_ANSWER_IMAGE_BYTES);
  if (!bytes.byteLength) throw new BadRequest('The image is empty.');
  const type = TYPES.find((t) => t.magic(bytes));
  if (!type) throw new BadRequest('Paste a PNG, JPEG, GIF or WebP image.');
  const id = `answer_image:i${crypto.randomUUID().replaceAll('-', '')}`;
  // The file first, so a row never points at a missing file.
  await db.query(
    `type::file('materials', '/answers/' + <string>record::id(type::record($id))).put(encoding::base64::decode($b64));
     CREATE type::record($id) CONTENT { owner: type::record($owner), answer: type::record($answer), mime: $mime, size: $size };`,
    { id, owner: userId, answer, mime: type.mime, size: bytes.byteLength, b64: toBase64(bytes) },
  );
  return id;
}

/** An answer image by id, for the public route. */
export async function loadAnswerImage(env: Env, rawId: string): Promise<{ b64: string; mime: string } | null> {
  const id = recordId('answer_image', rawId);
  await ensureServerSchema(env);
  return Surreal.system(env).query<{ b64: string; mime: string } | null>(
    `LET $row = SELECT mime FROM ONLY type::record($id);
     LET $bytes = IF $row { type::file('materials', '/answers/' + <string>record::id(type::record($id))).get() } ELSE { NONE };
     RETURN IF $row AND $bytes { { mime: $row.mime, b64: encoding::base64::encode($bytes) } } ELSE { NONE };`,
    { id },
  );
}
