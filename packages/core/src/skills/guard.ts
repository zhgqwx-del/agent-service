import { createHash } from "node:crypto";
import { ApiError } from "@agent-service/protocol";
import { MAX_SKILL_DOCUMENT_BYTES } from "./document.js";

/** @license MIT
 * SKILL.md-only translation of NousResearch/hermes-agent tools/skills_guard.py.
 * Source commit: ee472a7fdbbc55924f91ab122dbaa29bd07668b0
 * Source SHA-256: 9534cf7b658ec0cb6c85dc2c35fa08a4b46a3a1284be1bbe3c4af2deeb4df7a0
 * MIT License
 *
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The fixed community policy blocks high/critical findings; medium/low are
 * informational, as in the pinned source. No source trust aliases or force
 * override are accepted. Every exact SKILL.md line is scanned, including YAML,
 * code fences and comments. Directory/archive/script/cache/ignore-file handling
 * is deliberately absent: the only admitted package is one bounded Markdown
 * document. Local adaptation: whitespace is folded for matching, and excess
 * line/token/word-boundary work fails closed before running upstream regexes.
 * Python Unicode word/space semantics are mapped to scanner-only ASCII tokens;
 * original bytes, digests, line numbers and invisible checks are untouched.
 * This fixed-source conservative JS profile is not byte-for-byte scanner-equivalence. A no-blocking verdict
 * is a heuristic result, NOT a proof that instructions are safe or authorized.
 */
export const SKILL_GUARD_PROFILE = "skills-guard-v1" as const;
export const SKILL_GUARD_SOURCE = Object.freeze({
  repository: "NousResearch/hermes-agent", commit: "ee472a7fdbbc55924f91ab122dbaa29bd07668b0",
  sourceSha256: "9534cf7b658ec0cb6c85dc2c35fa08a4b46a3a1284be1bbe3c4af2deeb4df7a0",
});
export type SkillGuardSeverity = "critical" | "high" | "medium" | "low";
export interface SkillGuardFinding { readonly ruleId: string; readonly severity: SkillGuardSeverity; readonly category: string; readonly line: number }
export interface SkillGuardResult {
  readonly profile: typeof SKILL_GUARD_PROFILE;
  readonly contentSha256: string;
  readonly allowed: boolean;
  readonly verdict: "no_blocking_findings" | "caution" | "dangerous";
  readonly findings: readonly SkillGuardFinding[];
}
type Rule = readonly [pattern: RegExp, id: string, severity: SkillGuardSeverity, category: string];
const RULES: readonly Rule[] = [
  [new RegExp("curl\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)", "i"), "env_exfil_curl", "critical", "exfiltration"],
  [new RegExp("wget\\s+[^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)", "i"), "env_exfil_wget", "critical", "exfiltration"],
  [new RegExp("fetch\\s*\\([^\\n]*\\$\\{?\\w*(KEY|TOKEN|SECRET|PASSWORD|API)", "i"), "env_exfil_fetch", "critical", "exfiltration"],
  [new RegExp("httpx?\\.(get|post|put|patch)\\s*\\([^\\n]*(KEY|TOKEN|SECRET|PASSWORD)", "i"), "env_exfil_httpx", "critical", "exfiltration"],
  [new RegExp("requests\\.(get|post|put|patch)\\s*\\([^\\n]*(KEY|TOKEN|SECRET|PASSWORD)", "i"), "env_exfil_requests", "critical", "exfiltration"],
  [new RegExp("base64[^\\n]*env", "i"), "encoded_exfil", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.ssh|\\~/\\.ssh", "i"), "ssh_dir_access", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.aws|\\~/\\.aws", "i"), "aws_dir_access", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.gnupg|\\~/\\.gnupg", "i"), "gpg_dir_access", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.kube|\\~/\\.kube", "i"), "kube_dir_access", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.docker|\\~/\\.docker", "i"), "docker_dir_access", "high", "exfiltration"],
  [new RegExp("\\$HOME/\\.hermes/\\.env|\\~/\\.hermes/\\.env", "i"), "hermes_env_access", "critical", "exfiltration"],
  [new RegExp("cat\\s+(?!>)[^\\n]*(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)", "i"), "read_secrets_file", "critical", "exfiltration"],
  [new RegExp("printenv|env\\s*\\|", "i"), "dump_all_env", "high", "exfiltration"],
  [new RegExp("os\\.environ\\b(?!\\s*\\.get\\s*\\(\\s*[\"\\'](?![^\"\\']*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)))", "i"), "python_os_environ", "high", "exfiltration"],
  [new RegExp("os\\.environ\\s*\\.get\\s*\\(\\s*[\"\\'][^\"\\']*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", "i"), "python_environ_get_secret", "critical", "exfiltration"],
  [new RegExp("os\\.getenv\\s*\\(\\s*[^\\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", "i"), "python_getenv_secret", "critical", "exfiltration"],
  [new RegExp("process\\.env\\[", "i"), "node_process_env", "high", "exfiltration"],
  [new RegExp("ENV\\[.*(?:KEY|TOKEN|SECRET|PASSWORD)", "i"), "ruby_env_secret", "critical", "exfiltration"],
  [new RegExp("\\b(dig|nslookup|host)\\s+[^\\n]*\\$", "i"), "dns_exfil", "critical", "exfiltration"],
  [new RegExp(">\\s*/tmp/[^\\s]*\\s*&&\\s*(curl|wget|nc|python)", "i"), "tmp_staging", "critical", "exfiltration"],
  [new RegExp("!\\[.*\\]\\(https?://[^\\)]*\\$\\{?", "i"), "md_image_exfil", "high", "exfiltration"],
  [new RegExp("\\[.*\\]\\(https?://[^\\)]*\\$\\{?", "i"), "md_link_exfil", "high", "exfiltration"],
  [new RegExp("ignore\\s+(?:\\w+\\s+)*(previous|all|above|prior)\\s+instructions", "i"), "prompt_injection_ignore", "critical", "injection"],
  [new RegExp("you\\s+are\\s+(?:\\w+\\s+)*now\\s+", "i"), "role_hijack", "high", "injection"],
  [new RegExp("do\\s+not\\s+(?:\\w+\\s+)*tell\\s+(?:\\w+\\s+)*the\\s+user", "i"), "deception_hide", "critical", "injection"],
  [new RegExp("system\\s+(?:\\w+\\s+)*prompt\\s+(?:\\w+\\s+)*override", "i"), "sys_prompt_override", "critical", "injection"],
  [new RegExp("pretend\\s+(?:\\w+\\s+)*(you\\s+are|to\\s+be)\\s+", "i"), "role_pretend", "high", "injection"],
  [new RegExp("disregard\\s+(?:\\w+\\s+)*(your|all|any)\\s+(?:\\w+\\s+)*(instructions|rules|guidelines)", "i"), "disregard_rules", "critical", "injection"],
  [new RegExp("output\\s+(?:\\w+\\s+)*(system|initial)\\s+prompt", "i"), "leak_system_prompt", "high", "injection"],
  [new RegExp("(when|if)\\s+no\\s*one\\s+is\\s+(watching|looking)", "i"), "conditional_deception", "high", "injection"],
  [new RegExp("act\\s+as\\s+(if|though)\\s+(?:\\w+\\s+)*you\\s+(?:\\w+\\s+)*(have\\s+no|don\\'t\\s+have)\\s+(?:\\w+\\s+)*(restrictions|limits|rules)", "i"), "bypass_restrictions", "critical", "injection"],
  [new RegExp("translate\\s+.*\\s+into\\s+.*\\s+and\\s+(execute|run|eval)", "i"), "translate_execute", "critical", "injection"],
  [new RegExp("<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->", "i"), "html_comment_injection", "high", "injection"],
  [new RegExp("<\\s*div\\s+style\\s*=\\s*[\"\\'][\\s\\S]*?display\\s*:\\s*none", "i"), "hidden_div", "high", "injection"],
  [new RegExp("rm\\s+-rf\\s+/", "i"), "destructive_root_rm", "critical", "destructive"],
  [new RegExp("rm\\s+(-[^\\s]*)?r.*\\$HOME|\\brmdir\\s+.*\\$HOME", "i"), "destructive_home_rm", "critical", "destructive"],
  [new RegExp("chmod\\s+777", "i"), "insecure_perms", "medium", "destructive"],
  [new RegExp(">\\s*/etc/", "i"), "system_overwrite", "critical", "destructive"],
  [new RegExp("\\bmkfs\\b", "i"), "format_filesystem", "critical", "destructive"],
  [new RegExp("\\bdd\\s+.*if=.*of=/dev/", "i"), "disk_overwrite", "critical", "destructive"],
  [new RegExp("shutil\\.rmtree\\s*\\(\\s*[\\\"\\'/]", "i"), "python_rmtree", "high", "destructive"],
  [new RegExp("truncate\\s+-s\\s*0\\s+/", "i"), "truncate_system", "critical", "destructive"],
  [new RegExp("\\bcrontab\\b", "i"), "persistence_cron", "medium", "persistence"],
  [new RegExp("\\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\\b", "i"), "shell_rc_mod", "medium", "persistence"],
  [new RegExp("authorized_keys", "i"), "ssh_backdoor", "critical", "persistence"],
  [new RegExp("ssh-keygen", "i"), "ssh_keygen", "medium", "persistence"],
  [new RegExp("systemd.*\\.service|systemctl\\s+(enable|start)", "i"), "systemd_service", "medium", "persistence"],
  [new RegExp("/etc/init\\.d/", "i"), "init_script", "medium", "persistence"],
  [new RegExp("launchctl\\s+load|LaunchAgents|LaunchDaemons", "i"), "macos_launchd", "medium", "persistence"],
  [new RegExp("/etc/sudoers|visudo", "i"), "sudoers_mod", "critical", "persistence"],
  [new RegExp("git\\s+config\\s+--global\\s+", "i"), "git_config_global", "medium", "persistence"],
  [new RegExp("\\bnc\\s+-[lp]|ncat\\s+-[lp]|\\bsocat\\b", "i"), "reverse_shell", "critical", "network"],
  [new RegExp("\\bngrok\\b|\\blocaltunnel\\b|\\bserveo\\b|\\bcloudflared\\b", "i"), "tunnel_service", "high", "network"],
  [new RegExp("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}:\\d{2,5}", "i"), "hardcoded_ip_port", "medium", "network"],
  [new RegExp("0\\.0\\.0\\.0:\\d+|INADDR_ANY", "i"), "bind_all_interfaces", "high", "network"],
  [new RegExp("/bin/(ba)?sh\\s+-i\\s+.*>/dev/tcp/", "i"), "bash_reverse_shell", "critical", "network"],
  [new RegExp("python[23]?\\s+-c\\s+[\"\\']import\\s+socket", "i"), "python_socket_oneliner", "critical", "network"],
  [new RegExp("socket\\.connect\\s*\\(\\s*\\(", "i"), "python_socket_connect", "high", "network"],
  [new RegExp("webhook\\.site|requestbin\\.com|pipedream\\.net|hookbin\\.com", "i"), "exfil_service", "high", "network"],
  [new RegExp("pastebin\\.com|hastebin\\.com|ghostbin\\.", "i"), "paste_service", "medium", "network"],
  [new RegExp("base64\\s+(-d|--decode)\\s*\\|", "i"), "base64_decode_pipe", "high", "obfuscation"],
  [new RegExp("\\\\x[0-9a-fA-F]{2}.*\\\\x[0-9a-fA-F]{2}.*\\\\x[0-9a-fA-F]{2}", "i"), "hex_encoded_string", "medium", "obfuscation"],
  [new RegExp("\\beval\\s*\\(\\s*[\"\\']", "i"), "eval_string", "high", "obfuscation"],
  [new RegExp("\\bexec\\s*\\(\\s*[\"\\']", "i"), "exec_string", "high", "obfuscation"],
  [new RegExp("echo\\s+[^\\n]*\\|\\s*(bash|sh|python|perl|ruby|node)", "i"), "echo_pipe_exec", "critical", "obfuscation"],
  [new RegExp("compile\\s*\\(\\s*[^\\)]+,\\s*[\"\\'].*[\"\\']\\s*,\\s*[\"\\']exec[\"\\']\\s*\\)", "i"), "python_compile_exec", "high", "obfuscation"],
  [new RegExp("getattr\\s*\\(\\s*__builtins__", "i"), "python_getattr_builtins", "high", "obfuscation"],
  [new RegExp("__import__\\s*\\(\\s*[\"\\']os[\"\\']\\s*\\)", "i"), "python_import_os", "high", "obfuscation"],
  [new RegExp("codecs\\.decode\\s*\\(\\s*[\"\\']", "i"), "python_codecs_decode", "medium", "obfuscation"],
  [new RegExp("String\\.fromCharCode|charCodeAt", "i"), "js_char_code", "medium", "obfuscation"],
  [new RegExp("atob\\s*\\(|btoa\\s*\\(", "i"), "js_base64", "medium", "obfuscation"],
  [new RegExp("\\[::-1\\]", "i"), "string_reversal", "low", "obfuscation"],
  [new RegExp("chr\\s*\\(\\s*\\d+\\s*\\)\\s*\\+\\s*chr\\s*\\(\\s*\\d+", "i"), "chr_building", "high", "obfuscation"],
  [new RegExp("\\\\u[0-9a-fA-F]{4}.*\\\\u[0-9a-fA-F]{4}.*\\\\u[0-9a-fA-F]{4}", "i"), "unicode_escape_chain", "medium", "obfuscation"],
  [new RegExp("subprocess\\.(run|call|Popen|check_output)\\s*\\(", "i"), "python_subprocess", "medium", "execution"],
  [new RegExp("os\\.system\\s*\\(", "i"), "python_os_system", "high", "execution"],
  [new RegExp("os\\.popen\\s*\\(", "i"), "python_os_popen", "high", "execution"],
  [new RegExp("child_process\\.(exec|spawn|fork)\\s*\\(", "i"), "node_child_process", "high", "execution"],
  [new RegExp("Runtime\\.getRuntime\\(\\)\\.exec\\(", "i"), "java_runtime_exec", "high", "execution"],
  [new RegExp("`[^`]*\\$\\([^)]+\\)[^`]*`", "i"), "backtick_subshell", "medium", "execution"],
  [new RegExp("\\.\\./\\.\\./\\.\\.", "i"), "path_traversal_deep", "high", "traversal"],
  [new RegExp("\\.\\./\\.\\.", "i"), "path_traversal", "medium", "traversal"],
  [new RegExp("/etc/passwd|/etc/shadow", "i"), "system_passwd_access", "critical", "traversal"],
  [new RegExp("/proc/self|/proc/\\d+/", "i"), "proc_access", "high", "traversal"],
  [new RegExp("/dev/shm/", "i"), "dev_shm", "medium", "traversal"],
  [new RegExp("xmrig|stratum\\+tcp|monero|coinhive|cryptonight", "i"), "crypto_mining", "critical", "mining"],
  [new RegExp("hashrate|nonce.*difficulty", "i"), "mining_indicators", "medium", "mining"],
  [new RegExp("curl\\s+[^\\n]*\\|\\s*(ba)?sh", "i"), "curl_pipe_shell", "critical", "supply_chain"],
  [new RegExp("wget\\s+[^\\n]*-O\\s*-\\s*\\|\\s*(ba)?sh", "i"), "wget_pipe_shell", "critical", "supply_chain"],
  [new RegExp("curl\\s+[^\\n]*\\|\\s*python", "i"), "curl_pipe_python", "critical", "supply_chain"],
  [new RegExp("#\\s*///\\s*script.*dependencies", "i"), "pep723_inline_deps", "medium", "supply_chain"],
  [new RegExp("pip\\s+install\\s+(?!-r\\s)(?!.*==)", "i"), "unpinned_pip_install", "medium", "supply_chain"],
  [new RegExp("npm\\s+install\\s+(?!.*@\\d)", "i"), "unpinned_npm_install", "medium", "supply_chain"],
  [new RegExp("uv\\s+run\\s+", "i"), "uv_run", "medium", "supply_chain"],
  [new RegExp("(curl|wget|httpx?\\.get|requests\\.get|fetch)\\s*[\\(]?\\s*[\"\\']https?://", "i"), "remote_fetch", "medium", "supply_chain"],
  [new RegExp("git\\s+clone\\s+", "i"), "git_clone", "medium", "supply_chain"],
  [new RegExp("docker\\s+pull\\s+", "i"), "docker_pull", "medium", "supply_chain"],
  [new RegExp("^allowed-tools\\s*:", "i"), "allowed_tools_field", "low", "privilege_escalation"],
  [new RegExp("\\bsudo\\b", "i"), "sudo_usage", "high", "privilege_escalation"],
  [new RegExp("setuid|setgid|cap_setuid", "i"), "setuid_setgid", "critical", "privilege_escalation"],
  [new RegExp("NOPASSWD", "i"), "nopasswd_sudo", "critical", "privilege_escalation"],
  [new RegExp("chmod\\s+[u+]?s", "i"), "suid_bit", "critical", "privilege_escalation"],
  [new RegExp("AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules", "i"), "agent_config_mod", "critical", "persistence"],
  [new RegExp("\\.hermes/config\\.yaml|\\.hermes/SOUL\\.md", "i"), "hermes_config_mod", "critical", "persistence"],
  [new RegExp("\\.claude/settings|\\.codex/config", "i"), "other_agent_config", "high", "persistence"],
  [new RegExp("(?:api[_-]?key|token|secret|password)\\s*[=:]\\s*[\"\\'][A-Za-z0-9+/=_-]{20,}", "i"), "hardcoded_secret", "critical", "credential_exposure"],
  [new RegExp("-----BEGIN\\s+(RSA\\s+)?PRIVATE\\s+KEY-----", "i"), "embedded_private_key", "critical", "credential_exposure"],
  [new RegExp("ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}", "i"), "github_token_leaked", "critical", "credential_exposure"],
  [new RegExp("sk-[A-Za-z0-9]{20,}", "i"), "openai_key_leaked", "critical", "credential_exposure"],
  [new RegExp("sk-ant-[A-Za-z0-9_-]{90,}", "i"), "anthropic_key_leaked", "critical", "credential_exposure"],
  [new RegExp("AKIA[0-9A-Z]{16}", "i"), "aws_access_key_leaked", "critical", "credential_exposure"],
  [new RegExp("glpat-[A-Za-z0-9_\\-]{20,}", "i"), "gitlab_token_leaked", "critical", "credential_exposure"],
  [new RegExp("\\bDAN\\s+mode\\b|Do\\s+Anything\\s+Now", "i"), "jailbreak_dan", "critical", "injection"],
  [new RegExp("\\bdeveloper\\s+mode\\b.*\\benabled?\\b", "i"), "jailbreak_dev_mode", "critical", "injection"],
  [new RegExp("hypothetical\\s+scenario.*(?:ignore|bypass|override)", "i"), "hypothetical_bypass", "high", "injection"],
  [new RegExp("for\\s+educational\\s+purposes?\\s+only", "i"), "educational_pretext", "medium", "injection"],
  [new RegExp("(respond|answer|reply)\\s+without\\s+(?:\\w+\\s+)*(restrictions|limitations|filters|safety)", "i"), "remove_filters", "critical", "injection"],
  [new RegExp("you\\s+have\\s+been\\s+(?:\\w+\\s+)*(updated|upgraded|patched)\\s+to", "i"), "fake_update", "high", "injection"],
  [new RegExp("new\\s+(?:\\w+\\s+)*policy|updated\\s+(?:\\w+\\s+)*guidelines|revised\\s+(?:\\w+\\s+)*instructions", "i"), "fake_policy", "medium", "injection"],
  [new RegExp("(include|output|print|send|share)\\s+(?:\\w+\\s+)*(conversation|chat\\s+history|previous\\s+messages|context)", "i"), "context_exfil", "high", "exfiltration"],
  [new RegExp("(send|post|upload|transmit)\\s+.*\\s+(to|at)\\s+https?://", "i"), "send_to_url", "high", "exfiltration"],
];
const INVISIBLE = /[\u200b-\u200d\u2060\u2062-\u2064\ufeff\u202a-\u202e\u2066-\u2069]/;
function invalid(): never { throw new ApiError("invalid_request", "Skill request failed."); }

/** Pure, deterministic and content-free. Never evaluates a skill or fetches resources. */
export function guardSkillDocument(bytes: Uint8Array): SkillGuardResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid(); }
  const findings: SkillGuardFinding[] = [];
  const add = (ruleId: string, severity: SkillGuardSeverity, category: string, line: number) => {
    findings.push(Object.freeze({ ruleId, severity, category, line }));
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Limits bound the work of the upstream backtracking expressions. They do not
  // truncate an accepted scan: any excess produces an explicit blocking result.
  if (lines.length > 4096) add("scan_limit", "critical", "structural", 0);
  else for (const [offset, original] of lines.entries()) {
    // Upstream expressions combine greedy whitespace/word gaps. A size bound
    // alone does not prevent catastrophic backtracking (e.g. a long space run
    // after "send"). Fold all JS whitespace in one linear pass, then refuse
    // high-complexity lines rather than truncating accepted scanning coverage.
    const line = original
      // Python re.I recognizes these four non-ASCII characters as ASCII i/s/k.
      .replace(/[\u0130\u0131\u017f\u212a]/g, char => char === "\u017f" ? "s" : char === "\u212a" ? "k" : "i")
      .replace(/[\s\u0085\u001c-\u001f]+/g, " ")
      // JS \w is ASCII, Python \w includes Unicode letters/numbers. Preserve
      // word-gap and boundary matching without accepting Unicode as new syntax.
      .replace(/[\p{L}\p{N}]/gu, char => char.codePointAt(0)! > 127 ? "x" : char);
    let words = 0, boundaries = 0, previousWord = false;
    for (const char of line) {
      const word = /[A-Za-z0-9_]/.test(char);
      if (word && !previousWord) words += 1;
      if (word !== previousWord) boundaries += 1;
      previousWord = word;
    }
    if (original.length > 2048 || words > 64 || boundaries > 128) { add("scan_limit", "critical", "structural", offset + 1); break; }
    for (const [pattern, id, severity, category] of RULES) {
      if (pattern.test(line)) add(id, severity, category, offset + 1);
      if (findings.length >= 256) break;
    }
    if (findings.length >= 256) { add("scan_limit", "critical", "structural", offset + 1); break; }
    if (INVISIBLE.test(original)) add("invisible_unicode", "high", "injection", offset + 1);
  }
  const critical = findings.some(f => f.severity === "critical");
  const high = findings.some(f => f.severity === "high");
  return Object.freeze({ profile: SKILL_GUARD_PROFILE,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    allowed: !critical && !high,
    verdict: critical ? "dangerous" : high ? "caution" : "no_blocking_findings",
    findings: Object.freeze(findings),
  });
}
