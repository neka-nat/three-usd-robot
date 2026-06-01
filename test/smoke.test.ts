import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "../src/index.js";

describe("package scaffold", () => {
  it("exposes package identity", () => {
    expect(PACKAGE_NAME).toBe("three-usd-robot");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
