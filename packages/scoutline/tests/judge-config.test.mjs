import test from "node:test";
import assert from "node:assert/strict";
import * as judgeConfig from "../dist/lib/judge-config.js";
const { judgeDescriptor } = judgeConfig;
import { ValidationError } from "../dist/lib/errors.js";
import { TYPESAFE_SYSTEMONE_ENDPOINT } from "../dist/lib/lean-typesafe-judge.js";

test("default preferences are disabled without certifying a descriptor", () => {
  const selected = judgeConfig.resolveJudgeSettings({}, {});
  assert.equal(selected.enabled, false);
  assert.equal(selected.route, "openrouter");
  assert.equal(selected.model, "typesafe/jev-1.14");
  assert.equal("descriptor" in selected, false);
  assert.ok(Object.isFrozen(selected));
});

test("environment overrides stored route preferences and selected credential", () => {
  const stored = { route: "openrouter", typesafe: { model: "jev-1.13.0", transmitConsent: false, apiKey: "stored" } };
  const selection = judgeConfig.resolveJudgeSettings({ SCOUTLINE_JUDGE: "typesafe", SCOUTLINE_JUDGE_MODEL: "jev-1.14.0", SCOUTLINE_JUDGE_TRANSMIT: "1", TYPESAFE_API_KEY: "env" }, stored);
  assert.equal(selection.enabled, true);
  assert.equal(selection.route, "typesafe");
  assert.equal(selection.model, "jev-1.14.0");
  assert.equal(selection.apiKey, "env");
  assert.equal(selection.descriptor.expectedResolvedModel, "jev-1.14.0");
  assert.ok(Object.isFrozen(selection));
  assert.ok(Object.isFrozen(selection.descriptor));
});

test("malformed higher-priority controls never fall back", () => {
  const stored = { route: "typesafe", typesafe: { transmitConsent: true, apiKey: "stored" } };
  for (const env of [{ SCOUTLINE_JUDGE: "" }, { SCOUTLINE_JUDGE_MODEL: "" }, { SCOUTLINE_JUDGE_TRANSMIT: "yes" }, { TYPESAFE_API_KEY: " " }]) {
    assert.throws(() => judgeConfig.resolveJudgeSettings(env, stored), ValidationError);
  }
});

test("stored settings reject unknown or malformed fields without leaking values", () => {
  for (const stored of [null, { openrouter: null }, { extra: "secret" }, { route: "secret" }, { openrouter: { transmitConsent: "secret" } }, { typesafe: { model: "secret" } }, { typesafe: { apiKey: " " } }]) {
    assert.throws(() => judgeConfig.parseJudgeSettings(stored), error => error instanceof ValidationError && !error.message.includes("secret"));
  }
});

test("direct key with default route refuses with actionable guidance", () => {
  assert.throws(() => judgeConfig.resolveJudgeSettings({ TYPESAFE_API_KEY: "direct", SCOUTLINE_JUDGE_TRANSMIT: "1" }), error => error instanceof ValidationError && error.message.includes("SCOUTLINE_JUDGE=typesafe"));
});

test("malformed stored settings refuse selection instead of falling back", () => {
  assert.throws(() => judgeConfig.resolveJudgeSettings({}, { route: "nope" }), ValidationError);
  assert.throws(() => judgeConfig.resolveJudgeSettings({}, { typesafe: { model: "jev-9.9.9" } }), ValidationError);
});

test("consent reversal disables judging without changing saved preferences", () => {
  const stored = { route: "typesafe", typesafe: { model: "jev-1.13.0", transmitConsent: true, apiKey: "stored" } };
  const enabled = judgeConfig.resolveJudgeSettings({}, stored);
  assert.equal(enabled.enabled, true);
  const disabled = judgeConfig.resolveJudgeSettings({ SCOUTLINE_JUDGE_TRANSMIT: "0" }, stored);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.route, "typesafe");
  assert.equal(disabled.model, "jev-1.13.0");
  assert.equal("apiKey" in disabled, false);
  assert.equal("descriptor" in disabled, false);
});

test("the direct descriptor endpoint equals the shipped native endpoint", () => {
  assert.equal(judgeConfig.judgeDescriptor("typesafe").endpoint, TYPESAFE_SYSTEMONE_ENDPOINT);
  assert.equal(judgeConfig.judgeDescriptor("openrouter").endpoint, "https://openrouter.ai/api/v1/systemone");
});

test("secret collection unions both routes including inactive overrides", () => {
  const stored = { openrouter: { apiKey: "stored-or" }, typesafe: { apiKey: "stored-ts" } };
  const secrets = judgeConfig.collectJudgeSecrets({ OPENROUTER_API_KEY: "env-or" }, stored);
  assert.ok(Array.isArray(secrets));
  assert.deepEqual([...secrets].sort(), ["env-or", "stored-or", "stored-ts"]);
});

test("finite profiles bind immutable exact model identities", () => {
  const expected = [
    ["openrouter", undefined, "typesafe/jev-1.14", "typesafe/jev-1.14-20261014"],
    ["openrouter", "typesafe/jev-1.13", "typesafe/jev-1.13", "typesafe/jev-1.13-20260917"],
    ["typesafe", undefined, "jev-1.13.0", "jev-1.13.0"],
    ["typesafe", "jev-1.14.0", "jev-1.14.0", "jev-1.14.0"],
  ];
  for (const [route, model, requested, resolved] of expected) {
    const descriptor = judgeDescriptor(route, model);
    assert.equal(descriptor.route, route);
    assert.equal(descriptor.requestedModel, requested);
    assert.equal(descriptor.expectedResolvedModel, resolved);
    assert.equal(descriptor.maxAttempts, 1);
    assert.equal(descriptor.allowFallbacks, false);
    assert.ok(Object.isFrozen(descriptor));
  }
  for (const [route, model] of [["openrouter", "typesafe/jev-latest"], ["typesafe", "jev-1.15.0"], ["bad", "jev-1.13.0"], ["openrouter", ""]]) {
    assert.throws(() => judgeDescriptor(route, model), ValidationError);
  }
});
