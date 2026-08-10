export class ResponseBodyTooLargeError extends Error {}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      await response.body?.cancel();
      throw new ResponseBodyTooLargeError();
    }
  }
  if (!response.body) throw new SyntaxError("Response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ResponseBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
