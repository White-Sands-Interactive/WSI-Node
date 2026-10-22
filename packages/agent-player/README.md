# @whitesands/agent-player

Start a remote game agent from a player class. You call `start` and `turn`. The SDK owns the MCP server. The model stays on the platform, so the game never sees the model key.

```bash
npm install @whitesands/agent-player
export WSI_PLATFORM_KEY=pk_...
export WSI_PLATFORM_URL=wss://your-platform.example
```

```ts
import { AgentServer } from "@whitesands/agent-player";

const agents = new AgentServer();
const ada = await agents.start(new Villager(world, "Ada"), {
  goal: "Collect all the wood",
});

const result = await ada.turn();
// { action: "move", args: { dx: 1, dy: 0 }, result, attempts: 1, usage }
```

`new AgentServer()` reads `WSI_PLATFORM_KEY` and `WSI_PLATFORM_URL`. Until a hosted URL is the default, set `WSI_PLATFORM_URL` (it falls back to `ws://127.0.0.1:8787`).

## Player class

- `see()` is the state tool. It must be public and return JSON-safe data.
- Every other public method is an action. The model calls one per turn.
- Methods whose names start with `_`, and the constructor, are not tools.
- Throw to reject an action. The platform asks the model once more, then `turn()` rejects with `TurnFailedError`.

Optional static metadata adds descriptions and argument types. Undeclared public methods are still tools. Without metadata, arguments accept any JSON value.

```ts
import { z } from "zod";

class Villager {
  static agent = {
    description: "A villager who gathers wood",
    actions: {
      move: {
        description: "Step by dx, dy",
        args: { dx: z.number().int(), dy: z.number().int() },
      },
      chop: { description: "Chop the tree on your tile" },
    },
  };
}
```

Use the same Zod major version the SDK depends on (`zod@3`).

## Turns

`turn()` does not choose the action. It unblocks that session's `wait`, then resolves when the platform has called one action (or retried once).

```ts
const result = await ada.turn({ timeoutMs: 30_000, signal });
```

| Field | Meaning |
| --- | --- |
| `action` | Tool the model called |
| `args` | Arguments it passed |
| `result` | What your method returned |
| `attempts` | `1`, or `2` when the first call failed |
| `usage` | Prompt and completion tokens for that turn |

## Errors

| Error | When |
| --- | --- |
| `PlatformAuthError` | The platform key was rejected |
| `ProtocolVersionError` | The SDK and platform disagree on the protocol |
| `TurnFailedError` | Both the action and the retry failed. `error.attempts` lists both |
| `TurnTimeoutError` | The platform did not finish within `timeoutMs` (default 60s) |
| `ConnectionLostError` | The socket dropped and could not be resumed |

The SDK reconnects with backoff and resumes sessions for 30 seconds. Subscribe with `agents.on(listener)` or `handle.on(listener)` for `action`, `retry`, `turnFailed`, `disconnected`, and `reconnected`.

```ts
await using agents = new AgentServer();
```

`await using` calls `close()`, which stops every session. The platform process keeps running.

## Testing without a network

```ts
import { AgentServer } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";

const agents = new AgentServer({
  inline: createTestPlatform([
    { name: "move", arguments: { dx: 1, dy: 0 } },
  ]),
});
```

`createTestPlatform` runs the same wait / act / retry loop in memory. No key, no socket.

## What runs where

| | Game process | Platform |
| --- | --- | --- |
| World and player methods | yes | no |
| MCP tools (`see`, actions, `wait`) | yes | calls them |
| Whose turn it is | `turn()` | no |
| Which action to take | no | the model |
| Model API key | no | yes |

## API reference

```bash
npm run docs -w @whitesands/agent-player
```

TypeDoc writes HTML to `packages/agent-player/docs`.
