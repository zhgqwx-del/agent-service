// Spike: verify the pi embedding assumptions from docs/design/00-architecture.md §6.1 / §14 #1
// against a real domestic provider (DashScope compatible-mode, qwen).
//
// Checks:
//  1. custom OpenAI-compatible provider + per-call apiKey (no process env) + custom fetch
//  2. multi-step tool loop with parallel tools, event stream mapping
//  3. abort mid-stream
//  4. steer during a run
//  5. resume from persisted messages in a fresh Agent instance
//  6. prefix stability: system message bytes identical across requests
//  7. finishTurn as max-steps valve
import { createHash } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "typebox";

const BASE_URL = process.env.API_BASE_URL!;
const API_KEY = process.env.API_KEY!;
const MODEL_ID = process.env.DEFAULT_MODEL ?? "qwen3.8-max";
if (!BASE_URL || !API_KEY) throw new Error("API_BASE_URL / API_KEY missing (run with --env-file=../../.env)");

// ---------- 1. provider without any env/global key ----------
const qwenModel: Model<"openai-completions"> = {
	id: MODEL_ID,
	name: MODEL_ID,
	api: "openai-completions",
	provider: "dashscope",
	baseUrl: BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
	compat: { thinkingFormat: "qwen", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
};
const models = createModels();
models.setProvider(
	createProvider({
		id: "dashscope",
		name: "DashScope (BYOK)",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "DashScope key",
				// only honour the per-call credential; never fall back to env/stored credentials
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "request" } : undefined),
			},
		},
		models: [qwenModel],
		api: openAICompletionsApi(),
	}),
);
const model = models.getModel("dashscope", MODEL_ID)!;

// capture outbound requests (headers + payload) via injected fetch
const captured: { headers: Record<string, string>; body: any }[] = [];
const auditFetch: typeof fetch = async (input, init) => {
	const h: Record<string, string> = {};
	new Headers(init?.headers).forEach((v, k) => (h[k] = k === "authorization" ? v.slice(0, 14) + "…" : v));
	captured.push({ headers: h, body: init?.body ? JSON.parse(String(init.body)) : undefined });
	return fetch(input, init);
};

// ---------- tools ----------
const calls: string[] = [];
const weatherTool: AgentTool<any> = {
	name: "get_weather",
	label: "Weather",
	description: "Get current weather for a city",
	parameters: Type.Object({ city: Type.String() }),
	execute: async (_id, { city }) => {
		calls.push(`get_weather(${city})`);
		await new Promise((r) => setTimeout(r, 300));
		return { content: [{ type: "text", text: `${city}: 22°C, cloudy` }], details: { city } };
	},
};
const timeTool: AgentTool<any> = {
	name: "get_time",
	label: "Time",
	description: "Get current time in a city",
	parameters: Type.Object({ city: Type.String() }),
	execute: async (_id, { city }) => {
		calls.push(`get_time(${city})`);
		return { content: [{ type: "text", text: `${city}: 15:04` }], details: {} };
	},
};

function makeAgent(messages: AgentMessage[] = [], opts: { maxSteps?: number } = {}) {
	let steps = 0;
	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a concise assistant. Use tools when asked about weather or time. Reply in Chinese.",
			model,
			tools: [weatherTool, timeTool],
			messages,
		},
		streamFn: (m, ctx, o) => models.streamSimple(m, ctx, { ...o, fetch: auditFetch }),
		getApiKey: async (provider) => (provider === "dashscope" ? API_KEY : undefined), // per-call BYOK
		toolExecution: "parallel",
		finishTurn: async ({ message }) => {
			if (message.stopReason === "error" || message.stopReason === "aborted") return;
			steps++;
			if (opts.maxSteps && steps >= opts.maxSteps) return { action: "end" };
			return undefined;
		},
	});
	return agent;
}

const seen: string[] = [];
function attach(agent: Agent, label: string, out = true) {
	agent.subscribe((ev: AgentEvent) => {
		const t = ev.type;
		if (t === "message_update") {
			const e = (ev as any).assistantMessageEvent;
			if (e.type === "text_delta" && out) process.stdout.write(e.delta);
			return;
		}
		seen.push(`${label}:${t}`);
		if (t === "tool_execution_start") console.log(`\n  [tool start] ${(ev as any).toolName} ${JSON.stringify((ev as any).args)}`);
		if (t === "tool_execution_end") console.log(`  [tool end]   ${(ev as any).toolName}`);
		if (t === "turn_end") console.log(`  [turn_end] stop=${(ev as any).message?.stopReason} usage=${JSON.stringify((ev as any).message?.usage)}`);
		if (t === "agent_end") console.log(`  [agent_end] messages=${(ev as any).messages?.length}`);
	});
}

function systemHash(body: any) {
	const sys = (body?.messages ?? []).filter((m: any) => m.role === "system" || m.role === "developer");
	return createHash("sha256").update(JSON.stringify({ sys, tools: body?.tools })).digest("hex").slice(0, 16);
}

// ---------- 2. multi-step tool run ----------
console.log("\n=== T1 tool loop (parallel tools) ===");
const a1 = makeAgent();
attach(a1, "t1");
const t0 = Date.now();
await a1.prompt("上海现在的天气和时间分别是什么？");
console.log(`\n  duration=${Date.now() - t0}ms tools=${JSON.stringify(calls)} requests=${captured.length}`);
console.log(`  auth header: ${captured[0]?.headers.authorization}  user-agent: ${captured[0]?.headers["user-agent"]}`);
console.log(`  other headers: ${Object.keys(captured[0]?.headers ?? {}).join(",")}`);
console.log(`  request[0] top-level keys: ${Object.keys(captured[0]?.body ?? {}).join(",")}`);
const persisted = a1.state.messages;
console.log(`  persisted messages: ${persisted.map((m: any) => m.role).join(" > ")}`);

// ---------- 6. prefix stability ----------
const hashes = captured.map((c) => systemHash(c.body));
console.log(`  prefix hashes per request: ${hashes.join(" ")}  stable=${new Set(hashes).size === 1}`);

// ---------- 5. resume in a fresh agent ----------
console.log("\n=== T2 resume from persisted messages ===");
const a2 = makeAgent(structuredClone(persisted));
attach(a2, "t2");
await a2.prompt("刚才我问的是哪个城市？只回答城市名。");
console.log(`  prefix hash (resumed): ${systemHash(captured.at(-1)!.body)}  same-as-first=${systemHash(captured.at(-1)!.body) === hashes[0]}`);

// ---------- 3. abort mid-stream ----------
console.log("\n=== T3 abort ===");
const a3 = makeAgent();
attach(a3, "t3", false);
let deltas = 0;
a3.subscribe((ev) => {
	if (ev.type === "message_update" && (ev as any).assistantMessageEvent.type === "text_delta" && ++deltas === 5) a3.abort();
});
await a3.prompt("请写一段 300 字的关于上海的介绍。");
const last3 = a3.state.messages.at(-1) as any;
console.log(`  deltas before abort=${deltas} last.role=${last3?.role} stopReason=${last3?.stopReason} isStreaming=${a3.state.isStreaming}`);

// ---------- 4. steer during a run ----------
console.log("\n=== T4 steer ===");
const a4 = makeAgent();
attach(a4, "t4", false);
let steered = false;
a4.subscribe((ev) => {
	if (ev.type === "tool_execution_start" && !steered) {
		steered = true;
		a4.steer({ role: "user", content: "另外也告诉我北京的时间。", timestamp: Date.now() });
	}
});
calls.length = 0;
await a4.prompt("上海的天气如何？");
console.log(`  tools after steer: ${JSON.stringify(calls)}`);
console.log(`  roles: ${a4.state.messages.map((m: any) => m.role).join(" > ")}`);
console.log(`  final: ${(a4.state.messages.at(-1) as any)?.content?.map?.((c: any) => c.text).join("") ?? ""}`);

// ---------- 7. finishTurn as max-steps valve ----------
console.log("\n=== T5 maxSteps=1 valve ===");
const a5 = makeAgent([], { maxSteps: 1 });
attach(a5, "t5", false);
calls.length = 0;
await a5.prompt("上海现在的天气和时间分别是什么？");
console.log(`  tools=${JSON.stringify(calls)} turn_ends=${seen.filter((s) => s === "t5:turn_end").length} (expect 1: tools ran, no follow-up LLM call)`);
console.log(`  last role=${(a5.state.messages.at(-1) as any)?.role}`);

console.log("\n=== event types seen ===");
console.log([...new Set(seen.map((s) => s.split(":")[1]))].join(", "));
