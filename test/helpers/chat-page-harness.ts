import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

type PageEvent = { type: string; detail?: unknown; defaultPrevented?: boolean; preventDefault(): void; [key: string]: unknown };
type Listener = (event: PageEvent) => unknown;
class Events {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  dispatchEvent(event: PageEvent) { for (const listener of this.listeners.get(event.type) ?? []) void listener(event); return !event.defaultPrevented; }
  emit(type: string, properties: Record<string, unknown> = {}) {
    const event = { type, ...properties, preventDefault() { this.defaultPrevented = true; } } as PageEvent;
    const tasks = (this.listeners.get(type) ?? []).map(listener => listener(event));
    return Promise.all(tasks);
  }
}

/** A small DOM surface, not an application reimplementation. Scripts, markup and SSE parsing are real. */
export class PageNode extends Events {
  parentElement: PageNode | null = null;
  childNodes: PageNode[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  private disabledValue = false;
  value = "";
  title = "";
  type = "";
  scrollTop = 0;
  clientHeight = 300;
  private height: number | undefined;
  private text = "";
  readonly mutations = { text: 0, children: 0, detach: 0 };
  constructor(readonly tagName: string) { super(); }
  get nodeType() { return this.tagName === "#text" ? 3 : 1; }
  get disabled(): boolean { return this.disabledValue; }
  set disabled(value: unknown) { this.disabledValue = Boolean(value); }
  get id() { return this.attributes.get("id") ?? ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get className() { return this.attributes.get("class") ?? ""; }
  set className(value: string) { this.attributes.set("class", value); }
  get classList() {
    const update = (name: string, add: boolean) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (add) names.add(name); else names.delete(name); this.className = [...names].join(" "); };
    return { add: (...names: string[]) => names.forEach(name => update(name, true)), remove: (...names: string[]) => names.forEach(name => update(name, false)),
      contains: (name: string) => this.className.split(/\s+/).includes(name), toggle: (name: string, force?: boolean) => { const add = force ?? !this.className.split(/\s+/).includes(name); update(name, add); return add; } };
  }
  get textContent(): string { return this.text + this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value: string) {
    this.mutations.text++;
    if (this.tagName === "#text") this.text = String(value);
    else {
      this.replaceChildren();
      if (String(value)) { const text = new PageNode("#text"); text.textContent = String(value); this.append(text); }
    }
  }
  get nodeValue(): string | null { return this.tagName === "#text" ? this.text : null; }
  set nodeValue(value: string | null) { if (this.tagName === "#text") { this.mutations.text++; this.text = value ?? ""; } }
  get data(): string { return this.text; }
  set data(value: string) { this.nodeValue = String(value); }
  appendData(value: string) { this.nodeValue = this.text + String(value); }
  get firstChild(): PageNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): PageNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): PageNode | null { const parent = this.parentElement; return parent?.childNodes[parent.childNodes.indexOf(this) + 1] ?? null; }
  get children() { return this.childNodes.filter(node => node.tagName !== "#text"); }
  get scrollHeight() { return this.height ?? Math.max(this.clientHeight, this.childNodes.length * 100); }
  set scrollHeight(value: number) { this.height = value; }
  append(...nodes: (PageNode | string)[]) {
    for (const value of nodes) { const node = typeof value === "string" ? new PageNode("#text") : value; if (typeof value === "string") node.textContent = value; node.remove(); node.parentElement = this; this.childNodes.push(node); this.mutations.children++; }
  }
  appendChild(node: PageNode) { this.append(node); return node; }
  insertBefore(node: PageNode, reference: PageNode | null) {
    if (reference === null) return this.appendChild(node);
    if (reference.parentElement !== this) throw new Error("insertBefore reference does not belong to this parent");
    if (node === reference) return node;
    node.remove();
    const index = this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node); node.parentElement = this; this.mutations.children++;
    return node;
  }
  replaceChildren(...nodes: (PageNode | string)[]) { this.mutations.children++; this.text = ""; for (const node of this.childNodes) { node.mutations.detach++; node.parentElement = null; } this.childNodes = []; this.append(...nodes); }
  replaceWith(node: PageNode) { if (!this.parentElement || node === this) return; const parent = this.parentElement; node.remove(); const position = parent.childNodes.indexOf(this); parent.childNodes[position] = node; parent.mutations.children++; node.parentElement = parent; this.mutations.detach++; this.parentElement = null; }
  remove() { if (this.parentElement) { this.parentElement.mutations.children++; this.parentElement.childNodes = this.parentElement.childNodes.filter(node => node !== this); this.mutations.detach++; } this.parentElement = null; }
  contains(node: PageNode): boolean { return this === node || this.childNodes.some(child => child.contains(node)); }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return name.startsWith("data-") ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null : this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "hidden") this.hidden = false; if (name === "disabled") this.disabled = false; }
  matches(selector: string) {
    const attribute = selector.match(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/);
    if (attribute && (this.getAttribute(attribute[1]!) === null || (attribute[2] !== undefined && this.getAttribute(attribute[1]!) !== attribute[2]))) return false;
    const base = selector.replace(/\[[^\]]+\]/g, ""), id = base.match(/#([\w-]+)/)?.[1], classes = [...base.matchAll(/\.([\w-]+)/g)].map(match => match[1]!);
    const tag = base.match(/^[a-z][\w-]*/i)?.[0];
    return (!id || this.id === id) && classes.every(name => this.classList.contains(name)) && (!tag || this.tagName === tag.toLowerCase());
  }
  querySelectorAll(selector: string): PageNode[] {
    const parts = selector.trim().split(/\s+/), last = parts.pop()!;
    const found: PageNode[] = [];
    const visit = (node: PageNode) => { for (const child of node.children) { if (child.matches(last)) { let parent = child.parentElement, index = parts.length - 1; while (parent && index >= 0) { if (parent.matches(parts[index]!)) index--; parent = parent.parentElement; } if (index < 0) found.push(child); } visit(child); } };
    visit(this); return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): PageNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  focus(_options?: unknown) { /* Focus layout is covered by the real-browser check. */ }
  scrollIntoView(_options?: unknown) {}
  scrollTo(options: { top?: number } | number, y?: number) { this.scrollTop = typeof options === "number" ? y ?? 0 : options.top ?? this.scrollTop; }
  getBoundingClientRect() { const top = this.parentElement ? this.parentElement.childNodes.indexOf(this) * 100 - this.parentElement.scrollTop : 0; return { x: 0, y: top, top, bottom: top + 100, left: 0, right: 600, width: 600, height: 100 }; }
  requestSubmit() { return this.emit("submit"); }
}

class PageDocument extends PageNode {
  constructor(html: string) {
    super("document");
    const stack: PageNode[] = [this];
    const voids = new Set(["meta", "link", "input", "br", "hr", "img"]);
    for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
      if (token.startsWith("<!")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith("<")) {
        const tag = token.match(/^<([\w-]+)/)?.[1]?.toLowerCase(); if (!tag) continue;
        const node = new PageNode(tag);
        for (const match of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1]!, match[2] ?? "");
        stack.at(-1)!.append(node); if (!voids.has(tag) && !token.endsWith("/>")) stack.push(node);
      } else { const node = new PageNode("#text"); node.textContent = token; stack.at(-1)!.append(node); }
    }
  }
  createElement(tag: string) { return new PageNode(tag); }
  createTextNode(text: string) { const node = new PageNode("#text"); node.textContent = text; return node; }
  getElementById(id: string) { return this.querySelectorAll("*").find(node => node.id === id) ?? null; }
  getSelection() { return null; }
}

export type PageFetch = { path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal };
export async function createChatPage(options: { storage?: Map<string, string>; fetch(request: PageFetch): Promise<Response> | Response; script?: "app.js" | "environment.js" }) {
  const html = await readFile(new URL("../../scripts/ops/chat-h5/public/index.html", import.meta.url), "utf8");
  const document = new PageDocument(html), window = new Events(), storage = options.storage ?? new Map<string, string>();
  const calls: PageFetch[] = [], timers = new Map<number, { callback: () => unknown; delay: number; interval?: boolean }>();
  let timerId = 0, clock = 100, uuid = 0;
  const context = createContext({ document, window, console, TextEncoder, TextDecoder, URLSearchParams, AbortController,
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init: { detail?: unknown } = {}) { this.type = type; this.detail = init.detail; } preventDefault() {} },
    Event: class { constructor(readonly type: string) {} preventDefault() {} },
    navigator: { clipboard: { async writeText() {} } }, matchMedia: () => ({ matches: false }),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    performance: { now: () => clock },
    Date: class extends Date { static override now() { return 1_800_000_000_000 + clock; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setTimeout: (callback: () => unknown, delay = 0) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => unknown, delay = 0) => { const id = ++timerId; timers.set(id, { callback, delay, interval: true }); return id; },
    clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: (now: number) => unknown) => { const id = ++timerId; timers.set(id, { callback: () => callback(clock), delay: -1 }); return id; },
    cancelAnimationFrame: (id: number) => timers.delete(id),
    fetch: (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
      const call = { path: String(path), method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as Record<string, unknown> }), signal: init.signal };
      calls.push(call); return Promise.resolve(options.fetch(call));
    },
  });
  const source = await readFile(new URL(`../../scripts/ops/chat-h5/public/${options.script ?? "app.js"}`, import.meta.url), "utf8");
  runInContext(source, context, { filename: options.script ?? "app.js" });
  const flush = async () => { for (let pass = 0; pass < 100; pass++) await Promise.resolve(); for (const [id, timer] of [...timers]) if (timer.delay === -1) { timers.delete(id); timer.callback(); } for (let pass = 0; pass < 20; pass++) await Promise.resolve(); };
  const node = (id: string) => { const value = document.getElementById(id); if (!value) throw new Error(`Real page is missing #${id}`); return value; };
  return { document, window, storage, calls, node, flush,
    advance(ms: number) { clock += ms; },
    async timer(delay: number) { const found = [...timers].find(([, timer]) => timer.delay === delay); if (!found) throw new Error(`No pending timer for ${delay}ms`); if (!found[1].interval) timers.delete(found[0]); clock += delay; found[1].callback(); await flush(); },
    async close() { await window.emit("pagehide"); timers.clear(); await flush(); },
    environment(detail: Record<string, unknown>) { return document.emit("chat-environment-state", { detail }); },
    input(value: string) { node("message-input").value = value; return node("message-input").emit("input"); },
    submit() { return node("composer").emit("submit"); },
  };
}
