import { describe, expect, it } from "vitest";
import { assertDisposableClusterTargets } from "./safety.js";

describe("cluster destructive-target guard", () => {
  it("allows explicitly isolated cluster/test databases", () => {
    expect(() => assertDisposableClusterTargets(
      "mysql://root@127.0.0.1:3306/agent_service_cluster",
      "redis://127.0.0.1:6379/3",
    )).not.toThrow();
  });

  it("rejects a production-looking MySQL database", () => {
    expect(() => assertDisposableClusterTargets(
      "mysql://root@db.internal:3306/agent_service",
      "redis://redis.internal:6379/3",
    )).toThrow(/refusing to DROP/);
  });

  it("rejects Redis database zero", () => {
    expect(() => assertDisposableClusterTargets(
      "mysql://root@db.internal:3306/agent_service_test",
      "redis://redis.internal:6379/0",
    )).toThrow(/refusing to FLUSHDB/);
  });

  it("requires an explicit override for a disposable dedicated instance using database zero", () => {
    expect(() => assertDisposableClusterTargets(
      "mysql://root@127.0.0.1:3306/scratch",
      "redis://127.0.0.1:6379/0",
      true,
    )).not.toThrow();
  });
});
