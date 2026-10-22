# WSI Agent Player Framework

A TypeScript SDK so a game can start a remote agent from inside the game. The developer writes a player class and calls `start` and `turn`. The SDK owns the MCP server; the model stays on the platform.

The installable package is [`@whitesands/agent-player`](packages/agent-player/README.md). The platform it connects to is a separate Go service in [White-Sands-Interactive/Platform](https://github.com/White-Sands-Interactive/Platform).

```ts
import { AgentServer } from "@whitesands/agent-player";

const agents = new AgentServer(); // WSI_PLATFORM_KEY and WSI_PLATFORM_URL
const ada = await agents.start(new Villager(world, "Ada"), { goal: "Collect all the wood" });
const result = await ada.turn();
```

## Packages

| Package | Role |
| --- | --- |
| `@whitesands/agent-player` | Public SDK. In-process MCP server, outbound connection, class-to-tool reflection, `wait` / `turn` |
| `@whitesands/agent-player/testing` | Same agent loop, in memory, for tests and offline demos |
| `examples/forest` | Reflection-based forest demo |
| `examples/courier` | Typed actions and a goal |

## Develop

```bash
npm install
npm run build
npm test
npm run forest
npm run start -w @wsi/courier-example
```

Remote forest, with the Go platform running from the Platform repo:

```bash
./platform create-key demo
MODEL_API_KEY=... MODEL_BASE_URL=... MODEL_NAME=... ./platform serve
PLATFORM_KEY=pk_... npm run start -w @wsi/forest-example -- --remote
```

The wire protocol is `packages/agent-player/src/protocol.ts`. A change there needs the matching change in the Platform repo's `internal/protocol`.

## Publish

Changesets version the SDK. The publish workflow on `main` uses `NPM_TOKEN`. The package starts at `0.x`.
