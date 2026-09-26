import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { BlobStore } from "../types.js";

/** Local filesystem blob store (dev). Production swaps in OSS/S3 behind the same interface. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}
  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error("blob key escapes root");
    return p;
  }
  async put(key: string, data: Buffer | string, contentType?: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    if (contentType) await writeFile(`${p}.meta`, JSON.stringify({ contentType }));
    return { ref: `file://${key}` };
  }
  async get(ref: string) {
    const key = ref.replace(/^file:\/\//, "");
    try {
      const data = await readFile(this.path(key));
      let contentType: string | undefined;
      try {
        contentType = JSON.parse(await readFile(`${this.path(key)}.meta`, "utf8")).contentType;
      } catch {}
      return { data, contentType };
    } catch {
      return null;
    }
  }
  async delete(ref: string) {
    const key = ref.replace(/^file:\/\//, "");
    await unlink(this.path(key)).catch(() => {});
    await unlink(`${this.path(key)}.meta`).catch(() => {});
  }
}
