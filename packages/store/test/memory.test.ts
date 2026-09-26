import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "../src/index.js";
import { eventBusConformance, leaseStoreConformance, sessionStoreConformance } from "./conformance.js";

sessionStoreConformance("memory", async () => new MemorySessionStore());
leaseStoreConformance("memory", async () => new MemoryLeaseStore(), async (l, sid) => (l as MemoryLeaseStore).expire(sid));
eventBusConformance("memory", async () => new MemoryEventBus());
