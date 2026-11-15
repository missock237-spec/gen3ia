import { describe, expect, it } from "vitest";
import { sanitizeArchivePath } from "./path-security";

describe("ZIP path security", () => {
  it("normalizes safe nested paths", () => {
    expect(sanitizeArchivePath("src\\app\\index.ts")).toBe("src/app/index.ts");
  });

  it("rejects traversal", () => {
    expect(() => sanitizeArchivePath("../../etc/passwd")).toThrow();
    expect(() => sanitizeArchivePath("safe/../../../escape.txt")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => sanitizeArchivePath("/etc/passwd")).toThrow();
    expect(() => sanitizeArchivePath("C:/Windows/system32.txt")).toThrow();
  });

  it("rejects NUL bytes", () => {
    expect(() => sanitizeArchivePath("safe/file\0.txt")).toThrow();
  });
});
