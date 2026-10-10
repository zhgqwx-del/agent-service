import {
  CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";

const CHECK_ONLY = process.argv.includes("--check");
const WAIT_FOR_SERVER = process.argv.includes("--wait");
const MAX_WAIT_ATTEMPTS = 60;

class BootstrapInvariantError extends Error {}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseEndpoint(raw) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")
  ) throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin without credentials");
  return endpoint.origin;
}

function parseBucket(raw) {
  if (
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(raw)
    || raw.length > 63
    || raw.includes("..")
    || raw.includes(".-")
    || raw.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)
  ) throw new Error("S3_TEST_BUCKET must be a safe DNS-style bucket name");
  return raw;
}

function errorName(error) {
  return typeof error === "object" && error !== null
    ? String(error.name ?? error.Code ?? error.code ?? "Error")
    : "Error";
}

function httpStatus(error) {
  return typeof error === "object" && error !== null
    ? error.$metadata?.httpStatusCode
    : undefined;
}

function safeErrorMessage(error, sensitiveValues) {
  if (typeof error !== "object" || error === null || typeof error.message !== "string") return "";
  let message = error.message;
  for (const value of sensitiveValues) {
    if (value) message = message.split(value).join("[redacted]");
  }
  message = message.replace(/https?:\/\/\S+/gu, "[redacted-url]");
  return message.slice(0, 240);
}

function isMissingBucket(error) {
  return ["NotFound", "NoSuchBucket"].includes(errorName(error)) || httpStatus(error) === 404;
}

function isAlreadyOwned(error) {
  return ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(errorName(error));
}

function isMissingPolicy(error) {
  return errorName(error) === "NoSuchBucketPolicy" || httpStatus(error) === 404;
}

function isMissingLifecycleConfiguration(error) {
  return errorName(error) === "NoSuchLifecycleConfiguration";
}

function isTransient(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = errorName(current);
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "TimeoutError"].includes(code)) return true;
    current = typeof current === "object" && current !== null ? current.cause : undefined;
  }
  const status = httpStatus(error);
  return status === 429 || (status !== undefined && status >= 500);
}

async function bucketExists(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (isMissingBucket(error)) return false;
    throw error;
  }
}

async function assertUnversioned(client, bucket) {
  const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (result.Status !== undefined) {
    throw new BootstrapInvariantError("S3 test bucket must never have had versioning enabled");
  }
}

async function assertNoBucketPolicy(client, bucket) {
  try {
    await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  } catch (error) {
    if (isMissingPolicy(error)) return;
    throw error;
  }
  throw new BootstrapInvariantError("S3 test bucket must not have an access policy");
}

async function assertNoLifecycleConfiguration(client, bucket) {
  try {
    const result = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    if ((result.Rules?.length ?? 0) === 0) return;
  } catch (error) {
    if (isMissingLifecycleConfiguration(error)) return;
    throw error;
  }
  throw new BootstrapInvariantError("S3 test bucket must not have a lifecycle configuration");
}

async function bootstrap(client, bucket, region) {
  if (!(await bucketExists(client, bucket))) {
    try {
      await client.send(new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region } }),
      }));
    } catch (error) {
      if (!isAlreadyOwned(error)) throw error;
    }
  }

  // Versioning cannot be returned to the never-enabled state after it has been enabled. Refuse a
  // reused enabled/suspended bucket instead of hiding the mismatch with a suspend operation.
  await assertUnversioned(client, bucket);
  await assertNoLifecycleConfiguration(client, bucket);

  // A reused bucket with a policy is a configuration error. Never mutate or remove an existing
  // policy here: doing so could widen or break access for objects outside this test fixture.
  await assertNoBucketPolicy(client, bucket);
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  await assertNoLifecycleConfiguration(client, bucket);
  await assertNoBucketPolicy(client, bucket);
}

async function check(client, bucket) {
  if (!(await bucketExists(client, bucket))) throw new BootstrapInvariantError("S3 test bucket does not exist");
  await assertUnversioned(client, bucket);
  await assertNoLifecycleConfiguration(client, bucket);
  await assertNoBucketPolicy(client, bucket);
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error(`Node 24+ is required (current: ${process.version})`);
}

const endpoint = parseEndpoint(required("S3_TEST_ENDPOINT"));
const region = required("S3_TEST_REGION");
const bucket = parseBucket(required("S3_TEST_BUCKET"));
const accessKeyId = required("S3_TEST_ACCESS_KEY_ID");
const secretAccessKey = required("S3_TEST_SECRET_ACCESS_KEY");
const forcePathStyleRaw = process.env.S3_TEST_FORCE_PATH_STYLE ?? "0";
if (!["0", "1"].includes(forcePathStyleRaw)) {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}

const client = new S3Client({
  endpoint,
  region,
  forcePathStyle: forcePathStyleRaw === "1",
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
});

let lastError;
try {
  const attempts = WAIT_FOR_SERVER ? MAX_WAIT_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (CHECK_ONLY) await check(client, bucket);
      else await bootstrap(client, bucket, region);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransient(error)) break;
      await delay(1_000);
    }
  }
} finally {
  client.destroy();
}

if (lastError !== undefined) {
  const status = httpStatus(lastError);
  const message = safeErrorMessage(lastError, [endpoint, accessKeyId, secretAccessKey]);
  const detail = message ? `: ${message}` : "";
  console.error(`S3 bucket bootstrap failed (${errorName(lastError)}${status ? `, HTTP ${status}` : ""})${detail}`);
  process.exitCode = 1;
} else {
  console.log(`S3 bucket ${CHECK_ONLY ? "check" : "bootstrap"} passed (${bucket})`);
}
