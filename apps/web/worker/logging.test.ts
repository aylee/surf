import { describe, expect, it } from "vitest";
import { boundedErrorName } from "./logging";

describe("bounded error-name logging", () => {
  it("keeps approved built-in names and buckets attacker-controlled names", () => {
    expect(boundedErrorName(new TypeError("safe"))).toBe("TypeError");

    const malicious = new Error("sensitive message");
    malicious.name = "token-AIza-should-never-reach-logs";
    expect(boundedErrorName(malicious)).toBe("OtherError");
    expect(boundedErrorName("raw thrown secret")).toBe("ThrownString");
    expect(boundedErrorName(undefined)).toBe("ThrownUndefined");
  });

  it("reads Error.name once and returns only the first approved literal", () => {
    const changing = new Error("safe");
    let reads = 0;
    Object.defineProperty(changing, "name", {
      get() {
        reads += 1;
        return reads === 1 ? "TypeError" : "secret-on-second-read";
      }
    });

    expect(boundedErrorName(changing)).toBe("TypeError");
    expect(reads).toBe(1);
  });

  it("fails closed when Error.name throws", () => {
    const hostile = new Error("safe");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("secret from accessor");
      }
    });

    expect(() => boundedErrorName(hostile)).not.toThrow();
    expect(boundedErrorName(hostile)).toBe("UnknownError");
  });

  it("is total for hostile getPrototypeOf and revoked proxies", () => {
    const hostilePrototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secret from proxy trap");
        }
      }
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => boundedErrorName(hostilePrototype)).not.toThrow();
    expect(boundedErrorName(hostilePrototype)).toBe("UnknownError");
    expect(() => boundedErrorName(revocable.proxy)).not.toThrow();
    expect(boundedErrorName(revocable.proxy)).toBe("UnknownError");
  });
});
