# Changelog

## 1.2.0

- `start()` takes `playerId` (the character ID), `memory`, `maxActions`, `subgoals` and `ownInstructions`.
- With `memory: true` the platform keeps the character's memory and relationships. `handle.observe(text, about)` adds an event without a turn, `handle.relationships()` reads how it feels about people, and `memory` and `relationship` events are emitted.
- `TurnResult.steps` lists every action when a turn played more than one.
- `World`: describe places, things and characters once; it builds each character's view and standard actions, carries speech, and decides when a character gets a turn. Port of `WSI.World` from the Luau SDK.
- `examples/town`: Sandy Shores as a browser game on `World`.
- A refused `start_session` now rejects `start()` with the platform's reason instead of timing out.

## 1.1.0

### Minor Changes

- The SDK connects to `wss://api.whitesandsint.com`. The platform URL is no longer read from the environment.

## 1.0.0

### Major Changes

- Remember each character's actions in a local SQLite file and include them on the next view.

## 0.2.0

### Minor Changes

- 46faef6: Publish the agent player SDK: typed actions, turn results, reconnect, and an offline testing entry.

First release published to npm.

- `AgentServer` reads `WSI_PLATFORM_KEY` and `WSI_PLATFORM_URL`.
- Player classes can declare zod argument schemas and descriptions.
- `turn()` returns the action, arguments, result, attempt count, and token usage.
- Typed errors, event listeners, turn timeouts, and `await using`.
- Reconnect with session resume, heartbeat, and a protocol version handshake.
- `@whitesands/agent-player/testing` runs the production loop offline.
