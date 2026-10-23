import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { MysqlFixtureAuthorityOperation } from "./mysql-runtime.mjs";

export class MysqlAuthorityCliExecutorError extends Error { readonly code: "mysql_authority_cli_executor_failed"; readonly evidenceDirectory?: string; }
export interface MysqlAuthorityCliFileEvidence {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface MysqlAuthorityCliChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal: NodeJS.Signals): boolean;
}
/** Explicit synthetic dependencies are for ordering/refusal tests, not native process/DB proof. */
export interface MysqlAuthorityCliExecutorDependencies {
  readonly execPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  lstat(path: string): MysqlAuthorityCliFileEvidence;
  realpath(path: string): string;
  spawn(file: string, args: readonly string[], options: {
    cwd: string; env: Record<string, string>; stdio: readonly ["ignore", "pipe", "pipe"]; shell: false;
  }): MysqlAuthorityCliChild;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}
/** Does not authenticate source, signed artifact bytes, MySQL identity, or migration outcomes by itself. */
export function captureMysqlFixtureAuthorityCommand(input: unknown): Readonly<{ command: import("./mysql-runtime.mjs").MysqlFixtureAuthorityInitialCommand; commandSha256: string }>;
export function createMysqlAuthorityCliExecutor(input: Readonly<{
  entrypoint: string; mode: "source" | "dist"; cwd: string;
}>, dependencies?: MysqlAuthorityCliExecutorDependencies): (operation: MysqlFixtureAuthorityOperation) => Promise<void>;
