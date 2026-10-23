import type { MysqlFixtureDatabaseWitness, MysqlFixtureSchemaOperation, MysqlFixtureAuthorityOperation, MysqlRuntimeFixture } from "./mysql-runtime.mjs";

export class CiImageRuntimeError extends Error { readonly code: "ci_image_runtime_failed"; }
export interface CiImageRuntimeReady {
  readonly schema: "ci-image-mysql-runtime-v1";
  readonly status: "ready";
  readonly database: string;
  readonly serverUuid: string;
  readonly nativeConnectionsClosed: true;
  readonly runtimeEnvFile: "runtime.env";
  readonly runtimeEnvKeys: readonly string[];
  readonly resourceCleanup: "ephemeral-job-service-teardown-only";
  readonly perResourceCleanupClaimed: false;
}
export interface CiImageRuntimeAdmin {
  serverUuid(): Promise<string>;
  createDatabase(database: string): Promise<void>;
  /** Any settlement occurs after native connection/socket closure. */
  close(): Promise<void>;
}
/** Synthetic implementations only establish orchestration ordering, never Docker/SQL evidence. */
export interface CiImageRuntimeDependencies {
  readonly nodeMajor: number;
  inspectDirectory(directory: string): Promise<void>;
  openAdmin(url: string, signal: AbortSignal): Promise<CiImageRuntimeAdmin>;
  witness(input: Readonly<{ operatorUrl: string; applicationDatabase: string; operationAbortSignal: AbortSignal }>): Promise<MysqlFixtureDatabaseWitness>;
  prepare(witness: MysqlFixtureDatabaseWitness, input: Readonly<{
    schemaExecutor(operation: MysqlFixtureSchemaOperation): Promise<void>;
    authorityExecutor(operation: MysqlFixtureAuthorityOperation): Promise<void>;
  }>): Promise<MysqlRuntimeFixture>;
  createSchemaExecutor(input: Readonly<{ entrypoint: string; mode: "dist"; cwd: string }>): (operation: MysqlFixtureSchemaOperation) => Promise<void>;
  createAuthorityExecutor(input: Readonly<{ entrypoint: string; mode: "dist"; cwd: string }>): (operation: MysqlFixtureAuthorityOperation) => Promise<void>;
  nonce(): string;
  writePrivateFile(directory: string, name: "runtime.env" | "database.txt" | "ready.json", contents: string, signal: AbortSignal): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
  installInterrupts(interrupt: () => void): () => void;
  writeLine(line: string): void;
  writeError(line: string): void;
}
/** Allows selective synthetic adapters; never authenticates caller-supplied doubles. */
export const CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES: Readonly<CiImageRuntimeDependencies>;
export function prepareCiImageRuntime(argv: readonly string[], env: Readonly<Record<string, string | undefined>>,
  dependencies?: CiImageRuntimeDependencies): Promise<CiImageRuntimeReady>;
export function runCiImageRuntime(argv?: readonly string[], env?: Readonly<Record<string, string | undefined>>,
  dependencies?: CiImageRuntimeDependencies): Promise<0 | 1>;
