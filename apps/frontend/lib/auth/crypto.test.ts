import { describe, expect, it } from "vitest";
import { generateNonce, sha256Hex } from "./crypto";

describe("crypto auth helpers", () => {
  it("generates a random hex nonce of default length 64 characters (32 bytes)", () => {
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();
    expect(nonce1).toHaveLength(64);
    expect(nonce2).toHaveLength(64);
    expect(nonce1).not.toBe(nonce2);
    expect(/^[0-9a-f]{64}$/.test(nonce1)).toBe(true);
  });

  it("generates a nonce with custom byte length", () => {
    const nonce = generateNonce(16);
    expect(nonce).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(nonce)).toBe(true);
  });

  it("computes sha256 hex digest correctly", async () => {
    // SHA-256 for 'hello' is 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hash = await sha256Hex("hello");
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
