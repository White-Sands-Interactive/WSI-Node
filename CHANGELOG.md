# Changelog

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
