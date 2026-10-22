export type Logger = {
  debug?: (message: string, extra?: unknown) => void;
  info?: (message: string, extra?: unknown) => void;
  warn?: (message: string, extra?: unknown) => void;
  error?: (message: string, extra?: unknown) => void;
};

export function log(logger: Logger | undefined, level: keyof Logger, message: string, extra?: unknown): void {
  logger?.[level]?.(message, extra);
}
