#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelFromEnv } from "./model.js";
import { PlatformServer } from "./server.js";
import { PlatformStore } from "./store.js";

/** Stable default: packages/agent-platform/data (not process.cwd()). */
const PACKAGE_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
);

function usage(): never {
  console.log(`Usage:
  agent-platform create-key <accountName> [--data-dir <dir>]
  agent-platform create-key --name <accountName> [--data-dir <dir>]
  agent-platform serve [--port 8787] [--host 127.0.0.1] [--data-dir <dir>]
  agent-platform list-keys [--data-dir <dir>]

Environment (serve):
  MODEL_API_KEY / OPENAI_API_KEY   model API key
  MODEL_NAME                       default gpt-4o-mini
  MODEL_BASE_URL                   OpenAI-compatible base URL
  PLATFORM_SCRIPTED_MODEL          JSON array of {name, arguments} for tests
  PLATFORM_DATA_DIR                default: packages/agent-platform/data
`);
  process.exit(1);
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function resolveDataDir(rest: string[]): string {
  const fromArg = argValue(rest, "--data-dir");
  if (fromArg) {
    return path.isAbsolute(fromArg)
      ? fromArg
      : path.resolve(path.dirname(PACKAGE_DATA_DIR), fromArg);
  }

  const fromEnv = process.env.PLATFORM_DATA_DIR;
  if (fromEnv) {
    // Relative env paths are resolved from cwd and often create empty nested stores.
    // Only honor absolute paths; otherwise fall back to the package data dir.
    if (path.isAbsolute(fromEnv)) return fromEnv;
    console.warn(
      `[agent-platform] ignoring relative PLATFORM_DATA_DIR=${fromEnv}; using ${PACKAGE_DATA_DIR}`,
    );
  }
  return PACKAGE_DATA_DIR;
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) usage();

  const dataDir = resolveDataDir(rest);
  const store = new PlatformStore(dataDir);

  switch (cmd) {
    case "create-key": {
      const name = argValue(rest, "--name") ?? rest.find((a) => !a.startsWith("-"));
      if (!name) {
        console.error("account name is required (create-key <name> or --name <name>)");
        usage();
      }
      const record = await store.createKey(name);
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    case "list-keys": {
      const keys = await store.listKeys();
      console.log(JSON.stringify(keys, null, 2));
      return;
    }
    case "serve": {
      const port = Number(argValue(rest, "--port") ?? process.env.PLATFORM_PORT ?? 8787);
      const host = argValue(rest, "--host") ?? process.env.PLATFORM_HOST ?? "127.0.0.1";
      await store.load();
      const keys = await store.listKeys();
      if (keys.length === 0) {
        console.error(
          `[agent-platform] no platform keys in ${dataDir}\n` +
            `Run: npm run platform:create-key -- demo`,
        );
        process.exit(1);
      }
      const model = createModelFromEnv();
      const server = new PlatformServer({ port, host, store, model });
      const addr = await server.listen();
      console.log(`[agent-platform] listening on ws://${addr.host}:${addr.port}`);
      console.log(`[agent-platform] data dir ${dataDir} (${keys.length} key(s))`);

      const shutdown = async () => {
        console.log("[agent-platform] shutting down");
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      return;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
