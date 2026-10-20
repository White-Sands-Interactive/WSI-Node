# WSI Agent Player Framework

A TypeScript SDK and platform so a game can start a remote agent from inside the game. The developer writes a player class and calls `start` and `turn`. The SDK owns the MCP server; the model stays on the platform.

```ts
const agents = new AgentServer({ platformKey: process.env.PLATFORM_KEY! });
const ada = new Villager(world, "Ada");
const adaAgent = await agents.start(ada);

while (world.treesLeft() > 0) {
  await adaAgent.turn();
}
```

## Packages

| Package | Role |
| --- | --- |
| `@wsi/agent-player` | In-process MCP server, outbound platform connection, class-to-tool reflection, `wait` / `turn` |
| `@wsi/agent-platform` | Platform keys, per-session MCP client loop, one model, stored token usage |
| `examples/forest` | Two-villager forest demo |

## Quick start

```bash
npm install
npm run build

# Create a platform key (one-time) — stored in packages/agent-platform/data
npm run platform:create-key -- demo

# Terminal 1 — platform (set MODEL_API_KEY for a real model)
npm run platform

# Terminal 2 — forest example
export PLATFORM_KEY=<key from create-key>
npm run start -w @wsi/forest-example -- --remote
```

For local tests without a network, `AgentServer` accepts an inline platform (`createInlinePlatform`).

## Tests

```bash
npm test
```

## Developer surface

- Player class with a `see()` method and public action methods
- `new AgentServer({ platformKey })`
- `agents.start(player)` → `{ turn(), stop() }`
- `await agent.turn()` — unblocks that session’s `wait`, then resolves after one action (or throws after a second failed tool call)
