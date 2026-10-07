import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env.js";

describe("loadDotEnv", () => {
  const keys = ["MB_TEST_FROM_FILE", "MB_TEST_PRESET"];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it("returns false when there is no file", () => {
    expect(loadDotEnv(path.join(os.tmpdir(), "definitely-missing.env"))).toBe(false);
  });

  it("loads values from the file but never overrides the real environment", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mb-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, "MB_TEST_FROM_FILE=from-file\nMB_TEST_PRESET=from-file\n");
    process.env["MB_TEST_PRESET"] = "from-env";
    expect(loadDotEnv(file)).toBe(true);
    expect(process.env["MB_TEST_FROM_FILE"]).toBe("from-file");
    expect(process.env["MB_TEST_PRESET"]).toBe("from-env");
  });
});
