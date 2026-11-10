// Logging for the field-note scripts. Every line starts with an ISO 8601 UTC
// timestamp and goes to stdout and, with --log <path>, to that file too.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Logger {
  /** Log file path, or undefined when the run only prints to stdout. */
  readonly path: string | undefined;
  /** Write one stamped line per line of `message`. */
  log(message: string): void;
  /** A blank line, then "== title". */
  section(title: string): void;
}

/** ISO 8601 UTC to the second, for example 2026-10-15T11:37:08Z. */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Options every script accepts: --log <path> and --help. */
export const COMMON_OPTIONS = {
  log: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

/** Tee every line to stdout and, when `path` is set, to that file. The file starts empty. */
export function createLogger(path?: string): Logger {
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  const emit = (line: string): void => {
    process.stdout.write(`${line}\n`);
    if (path) appendFileSync(path, `${line}\n`);
  };
  const log = (message: string): void => {
    const ts = stamp();
    for (const line of message.split('\n')) emit(`${ts}  ${line}`.trimEnd());
  };
  return {
    path,
    log,
    section(title: string): void {
      log('');
      log(`== ${title}`);
    },
  };
}

/** Log the diagnosis and exit 1. No stack trace: the message is the diagnosis. */
export function fail(logger: Logger, message: string): never {
  logger.log(`FAIL  ${message}`);
  process.exit(1);
}

/** The message of an Error, or the string form of anything else. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Route errors that escape every try block into the log, so the --log file
 * holds the diagnosis and not only a stack trace on stderr.
 */
export function installCrashLogger(logger: Logger): void {
  const onError = (error: unknown): void => fail(logger, errorMessage(error));
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
}

/** Milliseconds as a short duration: "812 ms", "6.4 s", "2 min 05 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min} min ${String(sec).padStart(2, '0')} s`;
}

/** process.argv without node, the script and a leading "--" (pnpm 11 forwards it verbatim). */
export function scriptArgs(): string[] {
  const args = process.argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}

/** Print the usage text and exit 0 when --help was given. */
export function helpIfAsked(help: boolean, usage: string): void {
  if (help) {
    process.stdout.write(`${usage.trim()}\n`);
    process.exit(0);
  }
}
