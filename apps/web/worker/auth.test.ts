import { describe, expect, it } from "vitest";
import { bearerTokenMatches, type TimingSafeSubtleCrypto } from "./auth";

const testSubtle = {
  async digest(_algorithm: string, data: ArrayBuffer | ArrayBufferView) {
    const source = new Uint8Array(
      data instanceof ArrayBuffer ? data : data.buffer,
      data instanceof ArrayBuffer ? 0 : data.byteOffset,
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength
    );
    const digest = new Uint8Array(32);
    source.forEach((value, index) => {
      const target = index % digest.length;
      digest[target] = digest[target]! ^ value;
    });
    return digest.buffer;
  },
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) {
    const leftBytes = new Uint8Array(left instanceof ArrayBuffer ? left : left.buffer);
    const rightBytes = new Uint8Array(right instanceof ArrayBuffer ? right : right.buffer);
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < leftBytes.byteLength; index += 1) {
      difference |= leftBytes[index]! ^ rightBytes[index]!;
    }
    return difference === 0;
  }
} satisfies TimingSafeSubtleCrypto;

describe("manual ingest authentication", () => {
  it("accepts only the exact bearer token", async () => {
    await expect(bearerTokenMatches("Bearer secret", "secret", testSubtle)).resolves.toBe(true);
    await expect(bearerTokenMatches("Bearer wrong", "secret", testSubtle)).resolves.toBe(false);
  });

  it("fails closed when the header or configured secret is missing", async () => {
    await expect(bearerTokenMatches(undefined, "secret", testSubtle)).resolves.toBe(false);
    await expect(bearerTokenMatches("Bearer secret", undefined, testSubtle)).resolves.toBe(false);
  });
});
