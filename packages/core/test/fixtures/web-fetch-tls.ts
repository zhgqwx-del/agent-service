import { execFile } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface WebFetchTlsFixture {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  cleanup(): Promise<void>;
}

/**
 * TEST ONLY. Generate ephemeral synthetic TLS material without committing a private key.
 * No application env/secrets are inherited; OpenSSL writes only within this new directory.
 * Failed creation leaves its exact directory for diagnosis, never installs dependencies.
 */
export async function createWebFetchTlsFixture(): Promise<WebFetchTlsFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-web-fetch-tls-"));
  await chmod(directory, 0o700);
  const identity = await lstat(directory);
  const run = (args: readonly string[], phase: string): Promise<void> => new Promise((resolve, reject) => {
    // Both supported local macOS and Linux CI provide the system binary here.
    // execFile's callback runs after native child close, including timeout/failure.
    execFile("/usr/bin/openssl", [...args], {
      cwd: directory, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 32_768, encoding: "utf8",
    }, error => {
      if (!error) { resolve(); return; }
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new Error(missing
        ? `web_fetch TLS fixture requires system OpenSSL at /usr/bin/openssl; no installation attempted. Retained directory: ${directory}`
        : `web_fetch ephemeral TLS fixture ${phase} failed; native child closed. Retained directory: ${directory}`));
    });
  });
  try {
    const config = `[req]
prompt=no
distinguished_name=dn
x509_extensions=ca_extensions
[dn]
CN=Agent Service Ephemeral Web Fetch Test CA
[ca_extensions]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
`;
    // LibreSSL can prefer the configured DN over -subj. Keep the leaf request
    // entirely separate from the CA request so subject and issuer cannot collapse.
    const leafConfig = `[req]
prompt=no
distinguished_name=dn
[dn]
CN=web-fetch.fixture.test
[server_extensions]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:web-fetch.fixture.test
`;
    await writeFile(join(directory, "ca.cnf"), config, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "leaf.cnf"), leafConfig, { flag: "wx", mode: 0o600 });
    await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
      "-days", "1", "-config", "ca.cnf"], "CA generation");
    await run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr",
      "-config", "leaf.cnf"], "leaf request generation");
    await run(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "1",
      "-out", "server.pem", "-days", "1", "-extfile", "leaf.cnf", "-extensions", "server_extensions"], "leaf signing");
    const [ca, cert, key] = await Promise.all([
      readFile(join(directory, "ca.pem"), "utf8"), readFile(join(directory, "server.pem"), "utf8"), readFile(join(directory, "server.key"), "utf8"),
    ]);
    const authority = new X509Certificate(ca), leaf = new X509Certificate(cert);
    if (!authority.ca || leaf.ca || leaf.subject !== "CN=web-fetch.fixture.test" || leaf.subject === leaf.issuer
      || leaf.issuer !== authority.subject || !leaf.checkIssued(authority) || !leaf.verify(authority.publicKey)
      || !leaf.checkPrivateKey(createPrivateKey(key)) || leaf.checkHost("web-fetch.fixture.test", { subject: "never" }) !== "web-fetch.fixture.test") {
      throw new Error(`web_fetch ephemeral TLS fixture identity/chain is invalid. Retained directory: ${directory}`);
    }
    return { ca, cert, key, cleanup: async () => {
      const actual = await lstat(directory);
      if (!/^agent-service-web-fetch-tls-[A-Za-z0-9]+$/.test(basename(directory)) || !actual.isDirectory() || actual.isSymbolicLink()
        || actual.dev !== identity.dev || actual.ino !== identity.ino || actual.uid !== identity.uid) {
        throw new Error(`web_fetch TLS fixture directory identity changed; retained: ${directory}`);
      }
      await rm(directory, { recursive: true });
    } };
  } catch (error) {
    // Only closed local operation categories and the owned path are exposed, not stderr/key bytes.
    if (error instanceof Error && error.message.startsWith("web_fetch")) throw error;
    throw new Error(`web_fetch ephemeral TLS fixture preparation failed. Retained directory: ${directory}`);
  }
}
