/**
 * Doctor TTY presentation (T5 — fixes GitHub #95).
 *
 * `formatDiagnosticsReport` is a pure formatter: it takes the
 * availability-carrying diagnostics report plus an injected `now` and
 * renders a human-friendly TTY string. It NEVER sorts — the report
 * arrives healthy-first from the report builder; the formatter renders
 * rows in the given order. Data mode is unchanged: `doctor()` still
 * returns `{ kind: "data", data, exitCode }` with a byte-identical
 * payload; the TTY string rides `presentations.tty` (presentation-only).
 *
 * Tests are hand-built fixtures (no buildDiagnosticsReport) so the
 * formatter's contract is pinned independently of the builder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { doctor } from "../dist/commands/doctor.js";
import { formatDiagnosticsReport } from "../dist/lib/tty.js";

const NOW = 1_800_000_000_000;

/**
 * Mixed hand-built report (already healthy-first sorted, as
 * buildDiagnosticsReport would deliver): one ok row (fresh snapshot +
 * verified verification), one exhausted row (stale snapshot), one
 * unconfigured row (no quota/verification at all).
 */
function makeMixedReport() {
  return {
    schemaVersion: 2,
    effectiveProvider: "zai",
    capabilityMatrix: [
      { capability: "search", providers: ["zai", "exa"] },
      { capability: "reader", providers: ["tavily", "exa"] },
      { capability: "crawl", providers: ["tavily"] },
    ],
    node: { version: "v24.3.0", visionMcpCompatible: true },
    providers: [
      {
        provider: "zai",
        configured: true,
        capabilities: ["search", "vision"],
        status: "ok",
        availability: "ok",
        quota: { source: "snapshot", observedAt: NOW - 2 * 60_000, authoritative: true },
        verification: { status: "verified", checkedAt: NOW - 5 * 60_000 },
      },
      {
        provider: "tavily",
        configured: true,
        capabilities: ["search", "reader"],
        status: "error",
        error: { code: "API_ERROR", message: "probe blew up" },
        availability: "exhausted",
        quota: { source: "snapshot", observedAt: NOW - 30 * 60_000, authoritative: false },
      },
      {
        provider: "exa",
        configured: false,
        capabilities: ["search"],
        status: "skipped",
        reason: "not-configured",
        availability: "unconfigured",
      },
    ],
    availableProviders: ["zai"],
    cache: { summary: "enabled, 3 response entries (12.3 KB), /tmp/scoutline" },
  };
}

/** Index of the line that presents the named provider's availability row. */
function rowLineIndex(lines, provider, availability) {
  const idx = lines.findIndex(
    (line) => line.includes(provider) && line.includes(availability),
  );
  assert.ok(idx !== -1, `expected a row line containing "${provider}" + "${availability}"`);
  return idx;
}

describe("doctor --health TTY rendering", () => {
  it("renders the active health probe status and latency per provider row", () => {
    const report = makeMixedReport();
    report.providers[0].health = { healthy: true, latencyMs: 42, status: "ok" };
    const out = formatDiagnosticsReport(report, NOW);
    assert.match(out, /health probe ok/);
    assert.match(out, /42ms/);

    report.providers[1].health = {
      healthy: false,
      latencyMs: 77,
      status: "auth_error",
      error: "401 Unauthorized",
    };
    const out2 = formatDiagnosticsReport(report, NOW);
    assert.match(out2, /health probe auth_error/);
    assert.match(out2, /77ms/);
    assert.match(out2, /401 Unauthorized/);
  });
});

describe("doctor TTY presentation (#95)", () => {
  it("renders rows healthy-first in the report's given order (formatter does not sort)", () => {
    const out = formatDiagnosticsReport(makeMixedReport(), NOW);
    const lines = out.split("\n");
    const zai = rowLineIndex(lines, "zai", "ok");
    const tavily = rowLineIndex(lines, "tavily", "exhausted");
    const exa = rowLineIndex(lines, "exa", "unconfigured");
    assert.ok(zai < tavily, `ok row must precede exhausted row (${zai} < ${tavily})`);
    assert.ok(tavily < exa, `exhausted row must precede unconfigured row (${tavily} < ${exa})`);
  });

  it("shows an availability glyph and vocabulary label on every row", () => {
    const out = formatDiagnosticsReport(makeMixedReport(), NOW);
    const lines = out.split("\n");
    for (const [provider, availability] of [
      ["zai", "ok"],
      ["tavily", "exhausted"],
      ["exa", "unconfigured"],
    ]) {
      const line = lines[rowLineIndex(lines, provider, availability)];
      assert.ok(
        /✓|⚠|✗|·/.test(line),
        `row line for ${provider} carries a glyph: ${JSON.stringify(line)}`,
      );
    }
    // The whole closed vocabulary of this fixture is visible somewhere.
    assert.ok(out.includes("exhausted") && out.includes("unconfigured") && out.includes("ok"));
  });

  it("renders a source-age label for snapshot rows (fresh authoritative, stale non-authoritative)", () => {
    const report = makeMixedReport();
    const out = formatDiagnosticsReport(report, NOW);
    const lines = out.split("\n");
    const zai = rowLineIndex(lines, "zai", "ok");
    const tavily = rowLineIndex(lines, "tavily", "exhausted");
    const exa = rowLineIndex(lines, "exa", "unconfigured");

    const zaiSegment = lines.slice(zai, tavily).join("\n");
    assert.match(zaiSegment, /snapshot/, "zai snapshot source visible");
    assert.match(zaiSegment, /fresh/, "zai authoritative freshness visible");
    assert.match(zaiSegment, /2m ago/, "zai snapshot age visible against injected now");

    const tavilySegment = lines.slice(tavily, exa).join("\n");
    assert.match(tavilySegment, /snapshot/, "tavily snapshot source visible");
    assert.match(tavilySegment, /stale/, "tavily non-authoritative staleness visible");
    assert.match(tavilySegment, /30m ago/, "tavily snapshot age visible against injected now");
  });

  it("absent optional fields (cache, routing, verification, quota) render as absent — never 'undefined'", () => {
    const report = makeMixedReport();
    const bare = {
      ...report,
      cache: undefined,
      providers: report.providers.map((row) => ({
        ...row,
        quota: undefined,
        verification: undefined,
      })),
    };
    const out = formatDiagnosticsReport(bare, NOW);
    assert.ok(!out.includes("undefined"), `output must not contain 'undefined': ${out}`);
    assert.ok(!/^\s*.*\brouting\b/m.test(out), "no routing line when routing is absent");
    assert.ok(!/\bverification\b/.test(out), "no verification line when the field is absent");
  });

  it("renders the effective-provider, capabilityMatrix, cache, and routing summary lines when present", () => {
    const report = {
      ...makeMixedReport(),
      routing: { reader: ["tavily", "exa"] },
    };
    const out = formatDiagnosticsReport(report, NOW);
    assert.match(out, /effective provider/, "effective-provider summary line present");
    assert.match(out, /capabilityMatrix/, "capabilityMatrix summary line present");
    assert.match(out, /search×2/, "capabilityMatrix shows per-capability counts");
    assert.match(out, /cache/, "cache summary line present");
    assert.match(out, /enabled, 3 response entries/, "pre-formatted cache summary embedded");
    assert.match(out, /routing/, "routing summary line present");
    assert.match(out, /reader ← tavily, exa/, "routing entries rendered");
    assert.ok(!out.includes("undefined"));
  });

  it("doctor() attaches the tty presentation and leaves the data payload byte-identical", async () => {
    const report = makeMixedReport();
    const result = await doctor({
      buildReport: async () => report,
      now: () => NOW,
    });
    assert.strictEqual(result.kind, "data");
    // Exit semantics unchanged: the tavily row is a probe error -> exit 1.
    assert.strictEqual(result.exitCode, 1);
    // Data payload byte-compatible with what buildReport produced.
    assert.strictEqual(JSON.stringify(result.data), JSON.stringify(report));
    // tty is presentation-only: it rides presentations, never data.
    assert.ok(!("presentations" in result.data));
    assert.strictEqual(typeof result.presentations?.tty, "string");
    assert.ok(result.presentations.tty.length > 0);
    assert.ok(result.presentations.tty.includes("exhausted"));
  });

  it("doctor() exit code stays 0 for a fully healthy report", async () => {
    const report = makeMixedReport();
    const healthy = {
      ...report,
      providers: [report.providers[0]],
      availableProviders: ["zai"],
    };
    const result = await doctor({ buildReport: async () => healthy, now: () => NOW });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(typeof result.presentations?.tty, "string");
  });
});
