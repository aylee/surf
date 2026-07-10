export type TimingSafeSubtleCrypto = {
  digest(algorithm: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean;
};

const encoder = new TextEncoder();

export async function bearerTokenMatches(
  suppliedHeader: string | undefined,
  expectedToken: string | undefined,
  subtle: TimingSafeSubtleCrypto = crypto.subtle as unknown as TimingSafeSubtleCrypto
): Promise<boolean> {
  if (!suppliedHeader || !expectedToken) return false;

  const [suppliedDigest, expectedDigest] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(suppliedHeader)),
    subtle.digest("SHA-256", encoder.encode(`Bearer ${expectedToken}`))
  ]);
  return subtle.timingSafeEqual(suppliedDigest, expectedDigest);
}
