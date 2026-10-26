import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { verifyVmReleaseDirectory } from "../lib/vm-release.mjs";
import { assertListener, pinFile, processAbsent, readPrivateJson, sameProcess, writePrivateJson } from "./local-environment-native.mjs";

const NAMES = Object.freeze(["router", "runner", "mysql", "redis"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX = 16 * 1024 * 1024;
const ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
const need = (value, code = "environment_boot_proof_invalid") => { if (!value) throw new Error(code); };
const hash = value => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const absolute = value => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
const samePin = (a, b) => a?.path === b?.path && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha256 === b.sha256;
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
const contexts = new WeakSet();

async function native(file, args, { allowEmpty = false } = {}) {
  return await new Promise((done, reject) => execFile(file, args, { shell: false, env: ENV,
    timeout: 5000, maxBuffer: 262144, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && !(allowEmpty && error.code === 1 && stdout === "" && stderr === "")) reject(new Error("environment_boot_observation_failed"));
    else done(stdout);
  }));
}

/** Read immutable host identity and this OS boot, never wall clock or a PID. */
export async function readLocalBootIdentity() {
  try {
    const platform = process.platform, uid = process.getuid?.();
    need(Number.isSafeInteger(uid), "environment_boot_identity_unavailable");
    let bootId, hostId;
    if (platform === "darwin") {
      bootId = (await native("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).trim().toLowerCase();
      const hardware = await native("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const matches = [...hardware.matchAll(/"IOPlatformUUID"\s*=\s*"([a-fA-F0-9-]+)"/g)];
      need(matches.length === 1, "environment_boot_identity_unavailable");
      hostId = matches[0][1].toLowerCase();
      need(UUID.test(hostId), "environment_boot_identity_unavailable");
    } else if (platform === "linux") {
      bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
      hostId = (await readFile("/etc/machine-id", "utf8")).trim().toLowerCase();
      need(/^[a-f0-9]{32}$/.test(hostId), "environment_boot_identity_unavailable");
    } else throw new Error("environment_boot_identity_unavailable");
    need(UUID.test(bootId), "environment_boot_identity_unavailable");
    return Object.freeze({ schema: "local-environment-boot-identity-v1", platform, uid,
      hostSha256: hash(platform + "\n" + hostId), bootId });
  } catch { throw new Error("environment_boot_identity_unavailable"); }
}

export function isLocalBootIdentity(value) {
  return Boolean(value && value.schema === "local-environment-boot-identity-v1" && ["darwin", "linux"].includes(value.platform)
    && Number.isSafeInteger(value.uid) && value.uid >= 0 && SHA.test(value.hostSha256) && UUID.test(value.bootId));
}
export function sameBootHost(a, b) {
  return isLocalBootIdentity(a) && isLocalBootIdentity(b) && a.platform === b.platform && a.uid === b.uid && a.hostSha256 === b.hostSha256;
}
export function sameBootIdentity(a, b) { return sameBootHost(a, b) && a.bootId === b.bootId; }

/** Any listener on the configured port blocks recovery, regardless of its PID. */
export async function assertEnvironmentPortUnbound(port) {
  need(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const output = await native(process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
    ["-nP", "-a", "-iTCP:" + port, "-sTCP:LISTEN", "-Fp"], { allowEmpty: true });
  need(output === "", "environment_boot_port_in_use");
}

async function optionalPrivate(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return readPrivateJson(path, MAX);
}
async function readSelected(profilePath) {
  need(absolute(profilePath));
  const selected = await readPrivateJson(profilePath, MAX), profile = selected.value;
  need(profile?.schema === "local-environment-profile-v1" && absolute(profile.stateDirectory)
    && absolute(profile.originalState) && Array.isArray(profile.abandonedControllers));
  return { profile, profileSha256: selected.sha256, profilePath };
}
async function verifyProfileBindings(profile) {
  const state = await lstat(profile.stateDirectory);
  need(state.isDirectory() && !state.isSymbolicLink() && state.uid === process.getuid?.()
    && (state.mode & 0o7777) === 0o700 && await realpath(profile.stateDirectory) === profile.stateDirectory);
  need(Array.isArray(profile.directories) && profile.directories.length > 0 && Array.isArray(profile.files) && profile.files.length > 0);
  for (const item of profile.directories) {
    const stat = await lstat(item.path);
    need(absolute(item.path) && stat.isDirectory() && !stat.isSymbolicLink() && await realpath(item.path) === item.path
      && identity(stat) === item.identity, "environment_boot_data_changed");
  }
  need(samePin(await pinFile(profile.node.path), profile.node), "environment_boot_bindings_changed");
  for (const item of profile.files) need((await pinFile(item.path)).sha256 === item.sha256, "environment_boot_bindings_changed");
  for (const name of NAMES) {
    const config = profile.roles?.[name] ?? profile.infrastructure?.[name];
    need(config && samePin(await pinFile(config.executable.path), config.executable), "environment_boot_bindings_changed");
    const cwd = await lstat(config.cwd);
    need(cwd.isDirectory() && !cwd.isSymbolicLink() && await realpath(config.cwd) === config.cwd, "environment_boot_bindings_changed");
  }
  need(Array.isArray(profile.releaseBindings) && profile.releaseBindings.length === 2
    && new Set(profile.releaseBindings.map(binding => binding.role)).size === 2, "environment_boot_bindings_changed");
  for (const binding of profile.releaseBindings) {
    need(["agent-router", "agent-runner"].includes(binding.role));
    const manifest = await verifyVmReleaseDirectory(binding.directory, binding.role, binding.manifestSha256);
    need(manifest.publishable === true && manifest.source.sourceDirty === false
      && manifest.source.sourceCommit === profile.acceptedCommit, "environment_boot_bindings_changed");
  }
}
function settledLedger(ledger, selected) {
  const { profile, profilePath, profileSha256 } = selected;
  need(ledger?.schema === "local-environment-processes-v1" && ledger.profilePath === profilePath
    && ledger.profileSha256 === profileSha256 && ledger.stateDirectory === profile.stateDirectory
    && ledger.originalState === profile.originalState && ledger.acceptedCommit === profile.acceptedCommit);
  need(ledger.failure === null && ledger.activeOperation === null, "environment_boot_unsettled");
  for (const name of NAMES) {
    const entry = ledger.entries?.[name];
    need(entry && ["observed", "ready", "stopped"].includes(entry.state) && entry.failure == null
      && entry.unknownSpawnPid == null && entry.witness && samePin(entry.witness.executable,
        (profile.roles[name] ?? profile.infrastructure[name]).executable), "environment_boot_unsettled");
  }
}
function settledJournal(journal) {
  need(journal?.schema === "local-environment-journal-v1" && Array.isArray(journal.operations)
    && (journal.currentId === null || typeof journal.currentId === "string"), "environment_boot_unsettled");
  const ids = new Set();
  for (const operation of journal.operations) {
    need(operation && typeof operation.id === "string" && !ids.has(operation.id) && operation.state === "succeeded"
      && operation.error === null && typeof operation.finishedAt === "string" && Number.isFinite(Date.parse(operation.finishedAt)), "environment_boot_unsettled");
    ids.add(operation.id);
  }
  need(journal.currentId === null || ids.has(journal.currentId), "environment_boot_unsettled");
}
async function readLedgerAndJournal(selected) {
  const ledger = await readPrivateJson(join(selected.profile.stateDirectory, "processes.json"), MAX);
  const journal = await readPrivateJson(join(selected.profile.stateDirectory, "operations.json"), MAX);
  settledLedger(ledger.value, selected); settledJournal(journal.value);
  return { ledger, journal };
}
async function dataIdentityPins(profile) {
  const path = join(profile.dataIdentity.mysql.datadir, "auto.cnf"), pin = await pinFile(path);
  const text = await readFile(path, "utf8");
  need((await pinFile(path)).sha256 === pin.sha256 && /\[auto\]/.test(text), "environment_boot_data_changed");
  const uuids = [...text.matchAll(/^server-uuid\s*=\s*([^\r\n]+)\s*$/gm)].map(match => match[1].trim());
  need(uuids.length === 1 && uuids[0] === profile.infrastructure.mysql.uuid
    && uuids[0] === profile.dataIdentity.mysql.uuid, "environment_boot_data_changed");
  return [pin];
}
async function loadEnrollment(selected, currentBoot) {
  const file = await optionalPrivate(join(selected.profile.stateDirectory, "boot-enrollment.json"));
  if (!file) return null;
  const value = file.value;
  need(value?.schema === "local-environment-boot-enrollment-v1" && value.profilePath === selected.profilePath
    && value.profileSha256 === selected.profileSha256 && sameBootHost(value.boot, currentBoot)
    && SHA.test(value.ledgerSha256) && SHA.test(value.journalSha256) && Array.isArray(value.dataIdentityPins)
    && value.dataIdentityPins.length > 0 && equal(value.abandonedControllers, selected.profile.abandonedControllers));
  for (const pin of value.dataIdentityPins) need(samePin(await pinFile(pin.path), pin), "environment_boot_data_changed");
  return file;
}
async function loadReceipts(selected, enrollment, currentBoot) {
  const names = (await readdir(selected.profile.stateDirectory)).filter(name => /^boot-recovery-\d{6}\.json$/.test(name)).sort();
  need(names.length <= 999999);
  const receipts = [], bySha = new Map(), knownBoots = new Set([enrollment.value.boot.bootId]); let previous = null;
  for (let index = 0; index < names.length; index++) {
    need(names[index] === "boot-recovery-" + String(index + 1).padStart(6, "0") + ".json");
    const file = await readPrivateJson(join(selected.profile.stateDirectory, names[index]), MAX), value = file.value;
    need(value?.schema === "local-environment-boot-recovery-v1" && value.sequence === index + 1
      && value.profilePath === selected.profilePath && value.profileSha256 === selected.profileSha256
      && value.enrollmentSha256 === enrollment.sha256 && value.previousReceiptSha256 === previous
      && sameBootHost(value.previousBoot, currentBoot) && sameBootHost(value.currentBoot, currentBoot)
      && !sameBootIdentity(value.previousBoot, value.currentBoot) && SHA.test(value.sourceLedgerSha256)
      && SHA.test(value.journalSha256) && value.originalChildProcessCloseObserved === false
      && value.originalRecordsRetained === true && value.dataInitialized === false && value.ddlExecuted === false
      && value.modelCalls === 0 && Array.isArray(value.ports)
      && equal(value.ports, NAMES.map(name => (selected.profile.roles[name] ?? selected.profile.infrastructure[name]).port)));
    need(knownBoots.has(value.previousBoot.bootId));
    for (const name of NAMES) need(value.entries?.[name]?.witness && isLocalBootIdentity(value.entries[name].witnessBoot)
      && sameBootHost(value.entries[name].witnessBoot, currentBoot)
      && !sameBootIdentity(value.entries[name].witnessBoot, value.currentBoot));
    receipts.push(file); bySha.set(file.sha256, file); previous = file.sha256; knownBoots.add(value.currentBoot.bootId);
  }
  return { receipts, bySha };
}
function verifyRecordedBoot(ledger, enrollment, chain, { ledgerSha256, journalSha256 } = {}) {
  const recorded = ledger.bootIdentity ?? enrollment.value.boot;
  need(sameBootHost(recorded, enrollment.value.boot), "environment_boot_host_changed");
  if (ledger.bootIdentity == null) need(ledgerSha256 === enrollment.value.ledgerSha256
    && journalSha256 === enrollment.value.journalSha256, "environment_boot_bindings_changed");
  if (ledger.bootRecovery != null) {
    const receipt = chain.bySha.get(ledger.bootRecovery.receiptSha256);
    need(receipt && receipt.value.sequence === ledger.bootRecovery.sequence
      && sameBootIdentity(receipt.value.currentBoot, recorded), "environment_boot_proof_invalid");
  } else need(sameBootIdentity(recorded, enrollment.value.boot), "environment_boot_proof_invalid");
  for (const name of NAMES) {
    const entry = ledger.entries?.[name];
    if (entry?.witnessBoot == null) continue;
    need(sameBootHost(entry.witnessBoot, recorded));
    if (!sameBootIdentity(entry.witnessBoot, recorded)) {
      const receipt = chain.bySha.get(entry.previousBootAbsence?.receiptSha256);
      need(entry.state === "stopped" && receipt && entry.previousBootAbsence.schema === "local-environment-previous-boot-absence-v1"
        && entry.previousBootAbsence.originalChildProcessCloseObserved === false
        && entry.previousBootAbsence.receiptSha256 === ledger.bootRecovery?.receiptSha256
        && sameBootIdentity(receipt.value.currentBoot, recorded) && equal(receipt.value.entries[name].witness, entry.witness)
        && sameBootIdentity(receipt.value.entries[name].witnessBoot, entry.witnessBoot), "environment_boot_proof_invalid");
    }
  }
}

/** One-time enrollment requires the still-live controller and exact native identities. */
export async function enrollLocalEnvironmentBoot({ profilePath }, { readBootIdentity = readLocalBootIdentity,
  assertPortUnbound = assertEnvironmentPortUnbound } = {}) {
  const selected = await readSelected(profilePath), currentBoot = await readBootIdentity();
  need(isLocalBootIdentity(currentBoot));
  const existing = await loadEnrollment(selected, currentBoot);
  if (existing) return { boot: currentBoot, enrollmentSha256: existing.sha256, enrolled: false };
  await verifyProfileBindings(selected.profile);
  const { ledger, journal } = await readLedgerAndJournal(selected);
  if (ledger.value.bootIdentity != null) need(sameBootIdentity(ledger.value.bootIdentity, currentBoot));
  // A stale legacy ledger cannot enroll after a reboot: its OWNER must still be exact and live.
  await sameProcess(ledger.value.owner);
  for (const witness of selected.profile.abandonedControllers) need(await processAbsent(witness), "environment_boot_owner_present");
  for (const name of NAMES) {
    const entry = ledger.value.entries[name], port = (selected.profile.roles[name] ?? selected.profile.infrastructure[name]).port;
    if (entry.state === "stopped") { need(await processAbsent(entry.witness)); await assertPortUnbound(port); }
    else { await sameProcess(entry.witness); await assertListener(port, entry.witness.pid); }
  }
  const pins = await dataIdentityPins(selected.profile);
  need((await readPrivateJson(join(selected.profile.stateDirectory, "processes.json"), MAX)).sha256 === ledger.sha256
    && (await readPrivateJson(join(selected.profile.stateDirectory, "operations.json"), MAX)).sha256 === journal.sha256,
  "environment_boot_bindings_changed");
  const value = { schema: "local-environment-boot-enrollment-v1", profilePath, profileSha256: selected.profileSha256,
    boot: currentBoot, owner: ledger.value.owner, ledgerSha256: ledger.sha256, journalSha256: journal.sha256,
    abandonedControllers: selected.profile.abandonedControllers, dataIdentityPins: pins,
    observedAt: new Date().toISOString(), originalRecordsRetained: true, modelCalls: 0 };
  const written = await writePrivateJson(join(selected.profile.stateDirectory, "boot-enrollment.json"), value, { createOnly: true });
  return { boot: currentBoot, enrollmentSha256: written.sha256, enrolled: true };
}

/** Prepare a fresh immutable receipt; never edits a lock, old ledger, seal or report. */
export async function prepareLocalEnvironmentBootRecovery({ profilePath }, { readBootIdentity = readLocalBootIdentity,
  assertPortUnbound = assertEnvironmentPortUnbound } = {}) {
  const selected = await readSelected(profilePath), currentBoot = await readBootIdentity();
  need(isLocalBootIdentity(currentBoot));
  const enrollment = await loadEnrollment(selected, currentBoot);
  need(enrollment, "environment_boot_enrollment_required");
  const { ledger, journal } = await readLedgerAndJournal(selected);
  const previousBoot = ledger.value.bootIdentity ?? enrollment.value.boot;
  need(sameBootHost(previousBoot, currentBoot), "environment_boot_host_changed");
  const chain = await loadReceipts(selected, enrollment, currentBoot);
  verifyRecordedBoot(ledger.value, enrollment, chain, { ledgerSha256: ledger.sha256, journalSha256: journal.sha256 });
  if (sameBootIdentity(previousBoot, currentBoot)) return { crossBoot: false, boot: currentBoot };
  await verifyProfileBindings(selected.profile);
  for (const name of NAMES) await assertPortUnbound((selected.profile.roles[name] ?? selected.profile.infrastructure[name]).port);
  const entries = Object.fromEntries(NAMES.map(name => {
    const entry = ledger.value.entries[name], witnessBoot = entry.witnessBoot ?? previousBoot;
    need(sameBootHost(witnessBoot, currentBoot) && !sameBootIdentity(witnessBoot, currentBoot));
    return [name, { witness: entry.witness, witnessBoot }];
  }));
  const known = chain.receipts.find(file => file.value.sourceLedgerSha256 === ledger.sha256
    && file.value.journalSha256 === journal.sha256 && sameBootIdentity(file.value.currentBoot, currentBoot));
  if (known) return { crossBoot: true, boot: currentBoot, receiptSha256: known.sha256, sequence: known.value.sequence };
  const sequence = chain.receipts.length + 1; need(sequence <= 999999);
  const receipt = { schema: "local-environment-boot-recovery-v1", sequence,
    previousReceiptSha256: chain.receipts.at(-1)?.sha256 ?? null,
    profilePath, profileSha256: selected.profileSha256, enrollmentSha256: enrollment.sha256,
    previousBoot, currentBoot, sourceLedgerSha256: ledger.sha256, journalSha256: journal.sha256, entries,
    ports: NAMES.map(name => (selected.profile.roles[name] ?? selected.profile.infrastructure[name]).port),
    observedAt: new Date().toISOString(), originalChildProcessCloseObserved: false, originalRecordsRetained: true,
    dataInitialized: false, ddlExecuted: false, modelCalls: 0 };
  need((await readPrivateJson(join(selected.profile.stateDirectory, "processes.json"), MAX)).sha256 === ledger.sha256
    && (await readPrivateJson(join(selected.profile.stateDirectory, "operations.json"), MAX)).sha256 === journal.sha256,
  "environment_boot_bindings_changed");
  const written = await writePrivateJson(join(selected.profile.stateDirectory,
    "boot-recovery-" + String(sequence).padStart(6, "0") + ".json"), receipt, { createOnly: true });
  return { crossBoot: true, boot: currentBoot, receiptSha256: written.sha256, sequence };
}

/** Driver-only context. Cross-boot permission comes from validated fixed private files. */
export async function loadLocalEnvironmentBootContext({ profilePath, profileSha256, profile, ledger = null, ledgerSha256 = null },
  { readBootIdentity = readLocalBootIdentity, assertPortUnbound = assertEnvironmentPortUnbound } = {}) {
  const selected = { profilePath, profileSha256, profile }, currentBoot = await readBootIdentity();
  need(isLocalBootIdentity(currentBoot));
  const enrollment = await loadEnrollment(selected, currentBoot);
  const context = { currentBoot, enrollmentSha256: enrollment?.sha256 ?? null,
    abandonedBoot: enrollment?.value.boot ?? null, abandonedControllers: enrollment?.value.abandonedControllers ?? [],
    stateDirectory: profile.stateDirectory, crossBoot: false, receipt: null, receipts: new Map(), recovery: ledger?.bootRecovery ?? null };
  if (!enrollment) {
    need(ledger?.bootIdentity == null, "environment_boot_enrollment_required");
  } else {
    const chain = await loadReceipts(selected, enrollment, currentBoot); context.receipts = chain.bySha;
    const legacyJournal = ledger && ledger.bootIdentity == null
      ? await readPrivateJson(join(profile.stateDirectory, "operations.json"), MAX) : null;
    if (legacyJournal) settledJournal(legacyJournal.value);
    if (ledger) verifyRecordedBoot(ledger, enrollment, chain, { ledgerSha256, journalSha256: legacyJournal?.sha256 });
    const previousBoot = ledger?.bootIdentity ?? enrollment.value.boot;
    need(sameBootHost(previousBoot, currentBoot), "environment_boot_host_changed");
    if (ledger && !sameBootIdentity(previousBoot, currentBoot)) {
      settledLedger(ledger, selected);
      const journal = await readPrivateJson(join(profile.stateDirectory, "operations.json"), MAX); settledJournal(journal.value);
      const receipt = chain.receipts.findLast(file => file.value.sourceLedgerSha256 === ledgerSha256
        && file.value.journalSha256 === journal.sha256 && sameBootIdentity(file.value.currentBoot, currentBoot));
      need(receipt && sameBootIdentity(receipt.value.previousBoot, previousBoot), "environment_boot_recovery_required");
      for (const name of NAMES) need(equal(receipt.value.entries[name].witness, ledger.entries[name].witness)
        && sameBootIdentity(receipt.value.entries[name].witnessBoot, ledger.entries[name].witnessBoot ?? previousBoot));
      await verifyProfileBindings(profile);
      for (const name of NAMES) await assertPortUnbound((profile.roles[name] ?? profile.infrastructure[name]).port);
      context.crossBoot = true; context.receipt = receipt;
      context.recovery = { sequence: receipt.value.sequence, receiptSha256: receipt.sha256 };
    }
  }
  contexts.add(context); return context;
}

export function bootContextAllowsAbsentController(context, witness) {
  need(contexts.has(context));
  return Boolean(context.abandonedBoot && !sameBootIdentity(context.abandonedBoot, context.currentBoot)
    && context.abandonedControllers.some(item => equal(item, witness)));
}
export function bootContextAllowsPreviousEntry(context, name, entry) {
  need(contexts.has(context));
  const proof = context.receipts.get(entry.previousBootAbsence?.receiptSha256)?.value;
  return Boolean(NAMES.includes(name) && entry.state === "stopped" && proof
    && entry.previousBootAbsence.schema === "local-environment-previous-boot-absence-v1"
    && entry.previousBootAbsence.originalChildProcessCloseObserved === false
    && entry.previousBootAbsence.receiptSha256 === context.recovery?.receiptSha256
    && sameBootIdentity(proof.currentBoot, context.currentBoot)
    && sameBootHost(entry.witnessBoot, context.currentBoot) && !sameBootIdentity(entry.witnessBoot, context.currentBoot)
    && equal(proof.entries[name].witness, entry.witness)
    && sameBootIdentity(proof.entries[name].witnessBoot, entry.witnessBoot));
}

export async function assertLocalEnvironmentBootContextUnchanged(context) {
  need(contexts.has(context));
  const enrollment = await optionalPrivate(join(context.stateDirectory, "boot-enrollment.json"));
  // Enrollment may be added once while the legacy controller still runs. That
  // controller retains strict native checks until its next deliberate launch.
  if (context.enrollmentSha256 === null) return;
  need(enrollment?.sha256 === context.enrollmentSha256, "environment_boot_bindings_changed");
  const names = (await readdir(context.stateDirectory)).filter(name => /^boot-recovery-\d{6}\.json$/.test(name)).sort();
  need(names.length === context.receipts.size, "environment_boot_bindings_changed");
  for (const name of names) need(context.receipts.has((await readPrivateJson(join(context.stateDirectory, name), MAX)).sha256),
    "environment_boot_bindings_changed");
}
