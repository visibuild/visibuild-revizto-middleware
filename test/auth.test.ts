import { describe, it, expect } from "vitest";
import { createSessionToken, verifySessionToken, safeEqual } from "../src/auth";

const SECRET = "test-secret-key-0123456789";

describe("session tokens", () => {
  it("round-trips an admin session", async () => {
    const token = await createSessionToken(SECRET, "admin");
    const session = await verifySessionToken(SECRET, token);
    expect(session).not.toBeNull();
    expect(session!.role).toBe("admin");
    expect(session!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("round-trips a viewer session", async () => {
    const token = await createSessionToken(SECRET, "viewer");
    expect((await verifySessionToken(SECRET, token))!.role).toBe("viewer");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET, "admin");
    expect(await verifySessionToken("other-secret", token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET, "viewer");
    const [payload, sig] = token.split(".");
    // Flip a character in the payload – signature no longer matches.
    const tampered = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A") + "." + sig;
    expect(await verifySessionToken(SECRET, tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken(SECRET, "admin", -10);
    expect(await verifySessionToken(SECRET, token)).toBeNull();
  });

  it("rejects empty/garbage tokens", async () => {
    expect(await verifySessionToken(SECRET, "")).toBeNull();
    expect(await verifySessionToken(SECRET, undefined)).toBeNull();
    expect(await verifySessionToken(SECRET, "not-a-token")).toBeNull();
  });
});

describe("safeEqual", () => {
  it("is true for equal strings", () => {
    expect(safeEqual("hunter2", "hunter2")).toBe(true);
  });
  it("is false for different strings (incl. different lengths)", () => {
    expect(safeEqual("hunter2", "hunter3")).toBe(false);
    expect(safeEqual("short", "longer-value")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});
