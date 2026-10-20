import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlatformStore } from "./store.js";

describe("PlatformStore", () => {
  it("creates keys and accumulates token usage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wsi-platform-"));
    try {
      const store = new PlatformStore(dir);
      const key = await store.createKey("demo");
      expect(key.key.startsWith("pk_")).toBe(true);
      expect(key.name).toBe("demo");
      expect(key.tokenUsage).toBe(0);

      await store.addTokenUsage(key.key, 12);
      await store.addTokenUsage(key.key, 8);

      const again = new PlatformStore(dir);
      const found = await again.findKey(key.key);
      expect(found?.tokenUsage).toBe(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
