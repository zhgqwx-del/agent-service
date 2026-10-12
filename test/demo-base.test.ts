import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("manual acceptance entrypoint", () => {
  it("keeps an explicit router BASE ahead of .env without making a model request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-service-demo-base-"));
    try {
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, "bin"));
      await copyFile(resolve("scripts/demo.sh"), join(root, "scripts/demo.sh"));
      await writeFile(join(root, ".env"), "BASE=http://127.0.0.1:8787\n");
      const capture = join(root, "curl-capture");
      const fakeCurl = join(root, "bin", "curl");
      await writeFile(fakeCurl,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CURL_CAPTURE\"\nexit 22\n");
      await chmod(fakeCurl, 0o755);

      const env = {
        ...process.env,
        BASE: "http://127.0.0.1:8080",
        CURL_CAPTURE: capture,
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      };
      const result = spawnSync("bash", [join(root, "scripts", "demo.sh")], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(1); // Fake readiness failure stops before any model call.
      expect(await readFile(capture, "utf8"))
        .toBe("-fsS http://127.0.0.1:8080/readyz\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
