# WSI Agent Player

[![npm version](https://img.shields.io/npm/v/@whitesands/agent-player.svg)](https://www.npmjs.com/package/@whitesands/agent-player)
[![Build Status](https://github.com/White-Sands-Interactive/WSI-Node/actions/workflows/ci.yml/badge.svg)](https://github.com/White-Sands-Interactive/WSI-Node/actions/workflows/ci.yml)

The library starts a remote game agent from a player class. The game calls `start` and `turn`. The SDK publishes that class as tools. The model runs on the platform, so the game process never holds the model key.

The library also provides:

- A player class turned into tools, with optional Zod argument schemas.
- One action per turn, and one retry when that action throws.
- An offline loop for tests, with no socket and no platform key.
- A local SQLite log of what each character has already called.

## Documentation

This page is the guide. Generate the API reference with:

```sh
npm run docs
```

TypeDoc writes HTML to `docs`.

## Installation

You don't need this source code unless you want to modify the SDK. To use the package:

```sh
npm install @whitesands/agent-player
```

### Requirements

Node.js 20 or newer.

Installing the package builds `better-sqlite3`. npm uses a prebuilt binary on current macOS, Linux, and Windows. That module is the action log described below.

Use the same Zod 3 the SDK depends on when you declare argument schemas. Zod 4 objects are not read as schemas.

## Usage

Set the platform key, then start one agent per character. `turn()` grants that character one chance to act and resolves with what they did.

```sh
export WSI_PLATFORM_KEY=pk_...
```

The SDK connects to `wss://api.whitesandsint.com`.

```ts
import { AgentServer } from "@whitesands/agent-player";

const agents = new AgentServer();
const ada = await agents.start(new Villager(world, "Ada"), {
  name: "Ada",
  goal: "Stand on the tree and chop it",
});

const result = await ada.turn();
// { action: "move", args: { dx: 1, dy: 0 }, result, attempts: 1, usage }
```

`new AgentServer({ platformKey })` overrides `WSI_PLATFORM_KEY`.

### The player class

`see()` is required. It returns the JSON the model reads at the start of the turn. Every other public method is an action the model may call. Names that start with `_`, and the constructor, are left off the tool list.

Throw to refuse an action. The platform asks the model once more. A second failure rejects `turn()` with `TurnFailedError`.

```ts
class Villager {
  x = 0;
  y = 0;
  wood = 0;

  see() {
    return { x: this.x, y: this.y, wood: this.wood, tile: world.get(this.x, this.y) };
  }

  move(dx: number, dy: number) {
    const nextX = this.x + dx;
    const nextY = this.y + dy;
    if (!world.inBounds(nextX, nextY)) {
      throw new Error(`Cannot move to ${nextX},${nextY}`);
    }
    this.x = nextX;
    this.y = nextY;
    return { x: this.x, y: this.y };
  }

  chop() {
    if (world.get(this.x, this.y) !== "T") {
      throw new Error(`No tree at ${this.x},${this.y}`);
    }
    this.wood += 1;
    return { wood: this.wood };
  }
}
```

A method with no `static agent` entry is still a tool. Its arguments accept any JSON value.

### Declaring arguments

`static agent` adds the description the model sees and checks arguments with Zod before your method runs. A schema failure counts as a failed action and uses the one retry.

```ts
import { z } from "zod";

class Villager {
  static agent = {
    description: "A villager who gathers wood",
    actions: {
      move: {
        description: "Step by dx and dy. Stay inside the map.",
        args: { dx: z.number().int(), dy: z.number().int() },
      },
      chop: { description: "Chop the tree on your tile" },
    },
  };

  see() {
    return { x: this.x, y: this.y };
  }
}
```

### Turns

`turn()` does not choose the action. It unblocks that session's `wait`. The platform reads `see()`, calls one action, and reports back.

```ts
const result = await ada.turn({ timeoutMs: 30_000, signal });
```

| Field | Meaning |
| --- | --- |
| `action` | Tool the model called |
| `args` | Arguments it passed |
| `result` | What your method returned |
| `attempts` | `1`, or `2` when the first call failed and the retry succeeded |
| `usage` | `promptTokens` and `completionTokens` for that turn |

The default timeout is 60 seconds. Pass `signal` to abort the wait. `handle.stop()` ends that session. `agents.close()`, also run by `await using`, stops every session on the server. The platform process keeps running.

```ts
await using agents = new AgentServer();
```

### Errors

| Error | When |
| --- | --- |
| `PlatformAuthError` | The platform rejected the key |
| `ProtocolVersionError` | This SDK and the platform disagree on the protocol |
| `TurnFailedError` | The action and the retry both failed. `error.attempts` lists both calls |
| `TurnTimeoutError` | The platform did not finish within `timeoutMs` |
| `ConnectionLostError` | The socket dropped and the session could not be resumed |

The SDK reconnects with backoff. A disconnected session can be resumed for 30 seconds.

```ts
import { TurnFailedError } from "@whitesands/agent-player";

try {
  await ada.turn();
} catch (error) {
  if (error instanceof TurnFailedError) {
    console.log(error.attempts);
  }
  throw error;
}
```

### Several characters

One `AgentServer` hosts every character. Each `start()` is its own session.

```ts
const ada = await agents.start(new Villager(world, "Ada"), { name: "Ada", goal: "Chop the tree" });
const bea = await agents.start(new Villager(world, "Bea"), { name: "Bea", goal: "Carry wood home" });

await ada.turn();
await bea.turn();
```

The game decides whose turn it is by calling `turn()` on that handle.

### Events

`agents.on` hears every session. `handle.on` hears one session. Both return an unsubscribe function.

```ts
const stop = ada.on((event) => {
  if (event.type === "action") console.log(event.action, event.args);
  if (event.type === "retry") console.log(event.action, event.error);
  if (event.type === "turnFailed") console.log(event.error);
});
```

Connection events are `disconnected` and `reconnected`. Those have no `sessionId`.

### Action history

Every `start()` records that character's calls in one SQLite file, `.wsi/agent-memory.sqlite` in the process's current directory. The directory is created on the first `start()`. Deleting it is safe. The next start creates it again.

The next `see()` view includes `done`, oldest first, up to the last 50 calls for that session:

```json
{
  "x": 1,
  "y": 0,
  "done": [
    { "action": "move", "args": { "dx": 1, "dy": 0 }, "ok": true }
  ]
}
```

A refused call is `{ "ok": false, "error": "..." }`. A new `start()` has an empty `done` list. Older rows stay in the file. Two characters on one server share the file and see only their own rows. The name on each row is the `name` passed to `start()`, or the class name.

```ts
const agents = new AgentServer({
  memoryPath: "saves/agents.sqlite",
});
```

`memoryPath: false` turns the log off. The view then has no `done` field.

### Goal and instructions

`goal` is added to the model prompt for that character. `instructions` on `start()` is appended to the default prompt. `instructions` on `AgentServer` replaces the default prompt for every character on that server.

```ts
await agents.start(ferry, {
  name: "Ferryman",
  goal: "Get the wolf, the goat, and the cabbage onto the far bank.",
});
```

### Testing without a platform

`@whitesands/agent-player/testing` runs the same wait, act, and retry loop in memory. The script is the list of tool calls, in order. No key and no socket.

```ts
import { AgentServer } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";

const agents = new AgentServer({
  inline: createTestPlatform([
    { name: "move", arguments: { dx: 1, dy: 0 } },
    { name: "chop", arguments: {} },
  ]),
});
```

### Where each piece runs

| | Game process | Platform |
| --- | --- | --- |
| World and player methods | yes | |
| Tools (`see`, actions, `wait`) | yes | calls them |
| Whose turn it is | `turn()` | |
| Which action to take | | the model |
| Model API key | | yes |

### Logging

Pass a `logger` to print SDK warnings. Omit it and nothing is written.

```ts
const agents = new AgentServer({
  logger: {
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  },
});
```

`debug`, `info`, `warn`, and `error` are all optional.

### Protocol

`@whitesands/agent-player/protocol` exports the wire types and `PROTOCOL_VERSION`. Game code uses the main entry and does not import the protocol.

## This repository

| Path | Role |
| --- | --- |
| `src` | The published SDK |
| `examples/forest` | Two villagers, reflected methods |
| `examples/courier` | Zod arguments and a goal |
| `examples/ferry` | One passenger chosen each turn |

```sh
npm install
npm test
npm run build
npm run forest
npm run courier
npm run ferry
```

Each example replays a script. Forest and ferry can also call the hosted platform:

```sh
PLATFORM_KEY=pk_... npm run forest -- --remote
```

Releases are recorded in [CHANGELOG.md](CHANGELOG.md).
