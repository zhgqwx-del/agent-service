import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProviderConfig, ProviderConfigInput, ProviderFallbackRule, ProviderFallbackTarget } from "../src/provider.js";
import { ProviderConfigResponse, ProviderListResponse, UpsertProviderRequest } from "../src/http.js";

const input = () => ({ id: "provider-a", baseUrl: "https://provider.example/v1", models: [{ id: "model-a" }], fallback: ["legacy-provider"] });
const rule = (model = "model-a") => ({ model, targets: [{ provider: "provider-b", model: "model-b" }] });
const legacyParsed = () => ({ id: "provider-a", api: "openai-completions", baseUrl: "https://provider.example/v1", headers: {},
  models: [{ id: "model-a", contextWindow: 128000, maxOutputTokens: 8192, input: ["text"], reasoning: false }], quota: {}, fallback: ["legacy-provider"] });

describe("explicit provider fallback policy DTO", () => {
  it("keeps ProviderConfig a ZodObject with the original omit/extend input path", () => {
    expect(ProviderConfig).toBeInstanceOf(z.ZodObject); expect(ProviderConfigInput).toBeInstanceOf(z.ZodObject);
    expect(ProviderConfig.omit({ tenantId: true }).shape.id).toBe(ProviderConfig.shape.id);
    expect(ProviderConfigInput.shape.fallbackRules).toBe(ProviderConfig.shape.fallbackRules);
    expect(ProviderConfigInput.shape.allowPlatformPaidFallback).toBe(ProviderConfig.shape.allowPlatformPaidFallback);
  });
  it("does not add any new keys or change old parsed input/config bytes", () => {
    const parsedInput = ProviderConfigInput.parse(input()); expect(parsedInput).toEqual(legacyParsed());
    const config = ProviderConfig.parse({ ...input(), tenantId: "tenant-a", createdAtMs: 1, updatedAtMs: 2 });
    const expected = { ...legacyParsed(), tenantId: "tenant-a", createdAtMs: 1, updatedAtMs: 2 };
    expect(config).toEqual(expected); expect(JSON.stringify(config)).toBe(JSON.stringify({
      id: expected.id, tenantId: expected.tenantId, api: expected.api, baseUrl: expected.baseUrl, headers: expected.headers,
      models: expected.models, quota: expected.quota, fallback: expected.fallback, createdAtMs: expected.createdAtMs, updatedAtMs: expected.updatedAtMs,
    }));
    for (const value of [parsedInput, config]) {
      expect(Object.hasOwn(value, "fallbackRules")).toBe(false); expect(Object.hasOwn(value, "allowPlatformPaidFallback")).toBe(false);
    }
  });
  it("preserves legacy fallback declarations without generating explicit targets or payment opt-in", () => {
    const parsed = ProviderConfigInput.parse({ ...input(), fallback: ["legacy-provider", "legacy-provider"] });
    expect(parsed.fallback).toEqual(["legacy-provider", "legacy-provider"]);
    expect(Object.hasOwn(parsed, "fallbackRules")).toBe(false); expect(Object.hasOwn(parsed, "allowPlatformPaidFallback")).toBe(false);
  });
  it.each([false, true])("preserves the explicit boolean paid-platform opt-in %s", value => {
    const parsed = ProviderConfigInput.parse({ ...input(), fallbackRules: [rule()], allowPlatformPaidFallback: value });
    expect(parsed.allowPlatformPaidFallback).toBe(value); expect(parsed.fallbackRules).toEqual([rule()]);
  });
  it.each(["false", "true", 0, 1, null, {}, []])("rejects a non-boolean opt-in %#", value => {
    expect(ProviderConfigInput.safeParse({ ...input(), allowPlatformPaidFallback: value }).success).toBe(false);
  });
  it("accepts explicit empty rules, one target and both maximum cardinalities", () => {
    expect(ProviderConfigInput.parse({ ...input(), fallbackRules: [] }).fallbackRules).toEqual([]);
    expect(ProviderFallbackRule.parse(rule())).toEqual(rule());
    const rules = Array.from({ length: 32 }, (_, index) => ({ model: `source-${index}`,
      targets: Array.from({ length: 3 }, (_, target) => ({ provider: `target-${target}`, model: `model-${target}` })) }));
    expect(ProviderConfigInput.parse({ ...input(), fallbackRules: rules }).fallbackRules).toEqual(rules);
  });
  it("rejects more than 32 rules and targets outside the inclusive 1..3 range", () => {
    expect(ProviderConfigInput.safeParse({ ...input(), fallbackRules: Array.from({ length: 33 }, (_, n) => rule(`source-${n}`)) }).success).toBe(false);
    expect(ProviderFallbackRule.safeParse({ ...rule(), targets: [] }).success).toBe(false);
    expect(ProviderFallbackRule.safeParse({ ...rule(), targets: Array.from({ length: 4 }, (_, n) => ({ provider: `p-${n}`, model: `m-${n}` })) }).success).toBe(false);
  });
  it("rejects repeated exact source models and repeated exact provider/model target tuples", () => {
    expect(ProviderConfigInput.safeParse({ ...input(), fallbackRules: [rule(), { ...rule(), targets: [{ provider: "different", model: "different" }] }] }).success).toBe(false);
    expect(ProviderFallbackRule.safeParse({ ...rule(), targets: [rule().targets[0], { ...rule().targets[0] }] }).success).toBe(false);
  });
  it("keeps target tuple boundaries structural rather than joining ambiguous delimiters", () => {
    const targets = [{ provider: "a:b", model: "c" }, { provider: "a", model: "b:c" }, { provider: "a", model: "c" }];
    expect(ProviderFallbackRule.parse({ model: "source", targets }).targets).toEqual(targets);
  });
  it("preserves exact Unicode, whitespace and normalization-distinct external ids", () => {
    const rules = [{ model: "中".repeat(100) + " ", targets: [{ provider: " 提供者 ", model: "é" }, { provider: " 提供者 ", model: "e\u0301" }] },
      { model: "é", targets: [{ provider: "p", model: "m" }] }, { model: "e\u0301", targets: [{ provider: "p", model: "m" }] }];
    expect(ProviderConfigInput.parse({ ...input(), fallbackRules: rules }).fallbackRules).toEqual(rules);
  });
  it.each([
    { model: "", targets: [{ provider: "p", model: "m" }] }, { model: "x".repeat(129), targets: [{ provider: "p", model: "m" }] },
    { model: "m", targets: [{ provider: "", model: "m" }] }, { model: "m", targets: [{ provider: "p", model: "" }] },
    { model: "m", targets: [{ provider: "x".repeat(129), model: "m" }] }, { model: "m", targets: [{ provider: "p", model: "x".repeat(129) }] },
  ])("rejects external ids outside the existing grammar %#", value => {
    expect(ProviderFallbackRule.safeParse(value).success).toBe(false);
  });
  it("rejects missing fields and unknown rule/target fields instead of stripping them", () => {
    for (const value of [{ targets: rule().targets }, { model: "m" }, { ...rule(), retry: true }, { ...rule(), targets: [{ provider: "p", model: "m", apiKey: "test-only-forbidden" }] }]) {
      expect(ProviderFallbackRule.safeParse(value).success).toBe(false);
    }
    expect(ProviderFallbackTarget.safeParse({ provider: "p" }).success).toBe(false);
    expect(ProviderFallbackTarget.safeParse({ model: "m" }).success).toBe(false);
  });
  it("does not pretend structural parsing proves source existence, self-target policy or actual authorization", () => {
    const rules = [{ model: "not-present-in-models", targets: [{ provider: "provider-a", model: "not-present-in-models" }] }];
    expect(ProviderConfigInput.parse({ ...input(), fallbackRules: rules }).fallbackRules).toEqual(rules);
    expect(Object.hasOwn(ProviderConfigInput.parse({ ...input(), fallbackRules: rules }), "allowPlatformPaidFallback")).toBe(false);
  });
});

describe("legacy quota compatibility", () => {
  it("legacy quota compatibility: reads old positive integer limits through both formal response schemas", () => {
    const legacy = { ...ProviderConfig.parse({ ...input(), tenantId: "tenant-a", createdAtMs: 1, updatedAtMs: 2 }),
      quota: { rpm: 1_000_001, concurrency: 1_000_002 } };
    expect(ProviderConfigResponse.parse(legacy)).toEqual(legacy);
    expect(ProviderListResponse.parse({ data: [legacy] })).toEqual({ data: [legacy] });
  });

  it("legacy quota compatibility: keeps new input and PUT limits within 1..1000000", () => {
    const maximum = { ...input(), quota: { rpm: 1_000_000, concurrency: 1_000_000 } };
    const put = { baseUrl: maximum.baseUrl, models: maximum.models, fallback: maximum.fallback, quota: maximum.quota };
    expect(ProviderConfigInput.parse(maximum).quota).toEqual(maximum.quota);
    expect(UpsertProviderRequest.parse(put).quota).toEqual(maximum.quota);
    for (const field of ["rpm", "concurrency"] as const) {
      for (const value of [0, -1, 1.5, 1_000_001]) {
        const quota = { [field]: value };
        expect(ProviderConfigInput.safeParse({ ...input(), quota }).success).toBe(false);
        expect(UpsertProviderRequest.safeParse({ ...put, quota }).success).toBe(false);
      }
    }
  });
});
