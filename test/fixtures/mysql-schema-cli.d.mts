import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { MysqlFixtureSchemaOperation } from "./mysql-runtime.mjs";

export class MysqlSchemaCliExecutorError extends Error { readonly code: "mysql_schema_cli_executor_failed"; }
export interface MysqlSchemaCliFileEvidence {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface MysqlSchemaCliChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal: NodeJS.Signals): boolean;
}
/** Explicit synthetic dependencies are for ordering/refusal tests, not native process/DB proof. */
export interface MysqlSchemaCliExecutorDependencies {
  readonly execPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  lstat(path: string): MysqlSchemaCliFileEvidence;
  realpath(path: string): string;
  spawn(file: string, args: readonly string[], options: {
    cwd: string; env: Record<string, string>; stdio: readonly ["ignore", "pipe", "pipe"]; shell: false;
  }): MysqlSchemaCliChild;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}
/** Does not authenticate source, signed artifact bytes, MySQL identity, or migration outcomes by itself. */
export function createMysqlSchemaCliExecutor(input: Readonly<{
  entrypoint: string; mode: "source" | "dist"; cwd: string;
}>, dependencies?: MysqlSchemaCliExecutorDependencies): (operation: MysqlFixtureSchemaOperation) => Promise<void>;
