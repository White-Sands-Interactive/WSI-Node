import type { AttemptRecord } from "./protocol.js";

export class PlatformAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAuthError";
  }
}

export class ProtocolVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVersionError";
  }
}

export class TurnFailedError extends Error {
  readonly attempts: AttemptRecord[];

  constructor(message: string, attempts: AttemptRecord[] = []) {
    super(message);
    this.name = "TurnFailedError";
    this.attempts = attempts;
  }
}

export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnTimeoutError";
  }
}

/** The platform ended the session. Start a new session to keep playing the character. */
export class SessionEndedError extends Error {
  constructor(message = "The platform ended this session") {
    super(message);
    this.name = "SessionEndedError";
  }
}

export class ConnectionLostError extends Error {
  constructor(message = "Connection to the platform was lost") {
    super(message);
    this.name = "ConnectionLostError";
  }
}
