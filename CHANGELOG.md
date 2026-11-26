# Changelog

## Unreleased

- When the platform ends a session on its own (`session_stopped` with an `error`), the turn in flight and every later `turn()` reject with the new `SessionEndedError` instead of timing out, and a `sessionEnded` event is emitted.
- `World` starts a new session for a character whose session ended, or whose last 3 turns timed out (for platforms that do not send `session_stopped`). It emits a `restarted` event.
- After a reconnect, a session the platform no longer has (it restarted, or the resume grace ran out) ends with `SessionEndedError` instead of looping on reconnects. A socket that was already replaced no longer starts another reconnect.
- `World.pause()` stops turns and closes every character session. `resume()` opens new sessions and starts turns again.
- `examples/town`: character ids come from `TOWN_CAST_IDS=Mia=<uuid>,...`. Looks and starting places are in `cast.json`. `DEMO=1` turns on the visitor cap, passcode, `/health`, and the usage log.
- `turn_result.usage.model` is the model id that answered, including a fallback.

## 1.3.0

- `start()` takes `memory`, `maxActions`, `subgoals` and `ownInstructions`.
- With `memory: true` the platform keeps the character's memory and relationships. `handle.observe(text, about)` adds an event without a turn, `handle.relationships()` reads how it feels about people, and `memory` and `relationship` events are emitted.
- `TurnResult.steps` lists every action when a turn played more than one.
- `World`: describe places, things and characters once; it builds each character's view and standard actions, carries speech, and decides when a character gets a turn. Port of `WSI.World` from the Luau SDK.
- `examples/town`: Sandy Shores as a browser game on `World`.
- A refused `start_session` now rejects `start()` with the platform's reason instead of timing out.
- A reconnect that fails part-way can no longer end the process with an unhandled "Timed out waiting for session resume".

## 1.2.0

### Minor Changes

- Register a tool from a name, description, Zod schema, and callback with `bindDynamic`.
- `start()` requires `playerId`, the character UUID from the web app. One platform key serves the game, and each session names the character to play.

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
