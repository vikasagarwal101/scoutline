/**
 * Bounded in-memory response consumption (Incremental Stream Bounding).
 *
 * Lives in `src/lib/` because it is shared by direct commands (`fetch`,
 * `archive`) and by provider clients under `src/providers/`, which sit behind
 * the provider boundary and cannot import from `src/commands/`.
 */

import { ValidationError } from "./errors.js";

/**
 * Shared in-memory response ceiling for direct commands and provider clients.
 * Responses declaring or streaming beyond this ceiling reject immediately.
 */
export const MAX_BUFFERED_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Incrementally read from a ReadableStream up to maxBytes.
 * Throws ValidationError if incoming data exceeds maxBytes without buffering the remainder.
 */
export async function readBoundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  label = "Response size",
): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ValidationError(
            `${label} (${totalBytes} bytes) exceeds in-memory ceiling (${Math.round(maxBytes / (1024 * 1024))}MB).`,
            "Use --out <file> to stream large responses directly to disk.",
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    return Buffer.concat(chunks);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}
