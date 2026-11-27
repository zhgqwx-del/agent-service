import { BaseSequencer } from "vitest/node";
import { canonicalFile, check, MAIN_SHARD_COUNT, mainShardAssignments } from "./main-coverage-proof.mjs";

export default class MainCoverageSequencer extends BaseSequencer {
  async shard(specs) {
    const { root, shard } = this.ctx.config;
    check(shard.count === MAIN_SHARD_COUNT && shard.index >= 1 && shard.index <= MAIN_SHARD_COUNT, "shard_count");
    const files = specs.map((spec) => canonicalFile(spec.moduleId, root));
    const assigned = new Set(mainShardAssignments(files)[shard.index - 1]);
    return specs.filter((_, index) => assigned.has(files[index]));
  }
}
