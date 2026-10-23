import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

/** Actions kept on the view. Older rows stay in the file and drop off the prompt. */
const MAX_DONE = 50;

export type DoneAction = {
  action: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
};

type ActionRow = {
  action: string;
  args: string;
  ok: number;
  error: string | null;
};

/**
 * SQLite log of actions one game process has already called.
 * Each session reads only its own rows, so a new run starts with an empty list.
 */
export class SessionMemory {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { timeout: 5000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        character TEXT NOT NULL,
        action TEXT NOT NULL,
        args TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS actions_by_session ON actions(session_id, id);
    `);
  }

  record(sessionId: string, character: string, entry: DoneAction): void {
    this.db
      .prepare(
        `INSERT INTO actions (session_id, character, action, args, ok, error)
         VALUES (@sessionId, @character, @action, @args, @ok, @error)`,
      )
      .run({
        sessionId,
        character,
        action: entry.action,
        args: JSON.stringify(entry.args),
        ok: entry.ok ? 1 : 0,
        error: entry.error ?? null,
      });
  }

  /** Oldest first, capped to the most recent actions for this session. */
  done(sessionId: string): DoneAction[] {
    const rows = this.db
      .prepare(
        `SELECT action, args, ok, error FROM (
           SELECT id, action, args, ok, error FROM actions
           WHERE session_id = ?
           ORDER BY id DESC
           LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, MAX_DONE) as ActionRow[];
    return rows.map((row) => {
      const entry: DoneAction = {
        action: row.action,
        args: JSON.parse(row.args) as Record<string, unknown>,
        ok: row.ok === 1,
      };
      if (row.error) entry.error = row.error;
      return entry;
    });
  }

  close(): void {
    this.db.close();
  }
}

export function defaultMemoryPath(): string {
  return resolve(process.cwd(), ".wsi", "agent-memory.sqlite");
}

/** Attach this session's action log to a see() payload. */
export function viewWithDone(view: unknown, done: DoneAction[]): unknown {
  if (view && typeof view === "object" && !Array.isArray(view)) {
    return { ...(view as Record<string, unknown>), done };
  }
  return { view, done };
}
