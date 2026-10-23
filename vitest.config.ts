import path from "node:path";
import { defineConfig } from "vitest/config";

const player = path.resolve("src");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@whitesands/agent-player/testing", replacement: path.join(player, "testing.ts") },
      { find: "@whitesands/agent-player/protocol", replacement: path.join(player, "protocol.ts") },
      { find: "@whitesands/agent-player", replacement: path.join(player, "index.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
