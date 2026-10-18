import { it } from "node:test";
import assert from "node:assert/strict";
import { configuredSecrets, redactCredentialString, redactSecrets } from "../dist/lib/redact.js";
import { PROVIDER_PROMPT_META } from "../dist/commands/init.js";
import { getProviderAuthorityPolicy } from "../dist/lib/quota-mapping.js";
import { main } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

it("DeepSeek credentials are redacted in structured, assignment, whitespace, and literal-value paths", () => {
  const secret = "deepseek-secret-123";
  assert.deepEqual(configuredSecrets({ DEEPSEEK_API_KEY: secret }), [secret]);
  assert.deepEqual(redactSecrets({ DEEPSEEK_API_KEY: secret }), { DEEPSEEK_API_KEY: "[REDACTED]" });
  for (const text of [`DEEPSEEK_API_KEY=${secret}`, `deepseek_api_key: ${secret}`, `DEEPSEEK_API_KEY ${secret}`]) {
    assert.equal(redactCredentialString(text), "[REDACTED]");
  }
  assert.equal(redactSecrets(`query includes ${secret}`, configuredSecrets({ DEEPSEEK_API_KEY: secret })), "query includes [REDACTED]");
});

it("DeepSeek onboarding discloses its billable probe and quota ranking remains unknown", () => {
  assert.equal(PROVIDER_PROMPT_META.deepseek.envVar, "DEEPSEEK_API_KEY");
  assert.equal(PROVIDER_PROMPT_META.deepseek.probeCostsCredit, true);
  const policy = getProviderAuthorityPolicy("deepseek");
  assert.ok(policy);
  assert.equal(policy.kind, "always-unknown");
});

it("CLI routing resolves a file-configured DeepSeek key for search and read", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), ...init });
    if (String(url) === "https://api.deepseek.com/v1/tools/search") {
      return Response.json({ results: [{ title: "Result", url: "https://example.test/a", summary: "Summary" }] });
    }
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/fetch");
    return Response.json({ title: "Page", content: "# Page\n\nText" });
  });
  await withTempDir(t, async (dir) => {
    const run = async (argv) => {
      const stdout = [], stderr = [];
      const status = await main(argv, hermeticMainDeps({
        env: { SCOUTLINE_CONFIG_DIR: dir },
        quotaState: { version: 1, providers: {} },
        loadScoutlineConfig: async () => ({ version: 1, providers: { deepseek: { apiKey: "file-key-123" } },
          routing: { search: ["deepseek"], reader: ["deepseek"] }, fallbackEnabled: false }),
        invocation: { stdoutIsTTY: false, stdinIsTTY: false, environmentOutputMode: "data",
          readStdin: async () => "", writeStdout: (v) => stdout.push(v), writeStderr: (v) => stderr.push(v),
          runQuietly: async (op) => op(), setExitCode() {} },
      }));
      assert.equal(status, 0, stderr.join(""));
      assert.ok(!stdout.join("").includes("file-key-123"));
      return JSON.parse(stdout.join(""));
    };
    const rows = await run(["search", "q", "--count", "5"]);
    assert.equal(rows[0].summary, "Summary");
    const page = await run(["read", "https://example.test/page", "--provider", "deepseek"]);
    assert.equal(page.content, "# Page\n\nText");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, "Bearer file-key-123");
    assert.equal(calls[1].headers.Authorization, "Bearer file-key-123");
    assert.equal(JSON.parse(calls[0].body).count, 5);
  }, { prefix: "deepseek-cli-" });
});
