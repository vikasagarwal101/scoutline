/**
 * Search command characterization tests.
 *
 * P0-02 captures shipped behaviour of the search command, including merge,
 * rank, dedupe, occurrence sort, presentation modes, and the transitional
 * assertion that `count` currently enters the Z.AI client request (replaced
 * with local truncation in P2-05).
 *
 * Tests inject the SearchDependencies.clientFactory seam to avoid any
 * network or UTCP construction. The injected fake must expose webSearch()
 * and close().
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { search } from "../dist/commands/search.js";
import { setOutputMode, getOutputMode } from "../dist/lib/output.js";

const REAL_KEY = "test-key";
const ORIGINAL_MODE = getOutputMode();

/**
 * Create a fake search client that returns scripted results in call order.
 * Each call to webSearch pops the next scripted result array.
 * Returns { client, calls } where calls records the params of each call.
 */
function makeScriptedClient(resultsByCall) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async webSearch(params) {
      calls.push(params);
      const scripted = resultsByCall[i++];
      return scripted ?? [];
    },
    async close() {},
  };
}

/** Factory that always returns the same client instance. */
function singletonFactory(client) {
  return () => client;
}

/**
 * Factory that creates a fresh recorded client on each call.
 * Returns { factory, clients, closes }.
 */
function recordingFactory(makeClient) {
  const clients = [];
  const closes = [];
  const factory = () => {
    const c = makeClient();
    clients.push(c);
    return c;
  };
  return { factory, clients, closes };
}

async function withKey(fn) {
  const prev = process.env.Z_AI_API_KEY;
  process.env.Z_AI_API_KEY = REAL_KEY;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = prev;
  }
}

/**
 * Capture stdout by replacing process.stdout.write with a pass-through
 * wrapper. The node:test runner relies on process.stdout for IPC between
 * the test subprocess and parent; fully replacing the write method
 * silently drops test results. The wrapper forwards ALL writes to the
 * original so the test runner keeps working, and returns the accumulated
 * buffer for assertions.
 */
function captureStdout() {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (chunk, ...args) => {
    buf += chunk.toString();
    return original(chunk, ...args);
  };
  return () => {
    process.stdout.write = original;
    return buf;
  };
}

function silenceStderr() {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => {
    process.stderr.write = original;
  };
}

afterEach(() => {
  setOutputMode(ORIGINAL_MODE);
});

/**
 * Extract the search command output from a noisy stdout buffer.
 * The buffer contains both search output (a single JSON line or text
 * block) and test-runner protocol noise. In data mode, the search output
 * is the last line starting with '['. In text modes, it's the non-TAP text.
 */
function extractSearchJson(buf) {
  const lines = buf.split("\n");
  // The search JSON array is the last non-empty line starting with '['.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("[")) {
      return JSON.parse(line);
    }
  }
  throw new Error("No JSON array found in captured stdout");
}

function extractSearchText(buf) {
  // For text modes (compact/markdown/refs), the search output is
  // the non-TAP, non-empty content. Extract lines that are part of
  // the search results.
  const lines = buf.split("\n").filter((l) => {
    const t = l.trimStart();
    return (
      t.length > 0 &&
      !t.startsWith("#") &&
      !t.startsWith("ok ") &&
      !t.startsWith("not ok") &&
      !t.startsWith("TAP") &&
      !t.startsWith("1..") &&
      !t.startsWith("{") &&
      !t.startsWith('"type"') &&
      t !== "..." &&
      !t.startsWith("duration_ms") &&
      !t.startsWith("tests ") &&
      !t.startsWith("suites ") &&
      !t.startsWith("pass ") &&
      !t.startsWith("fail ")
    );
  });
  return lines.join("\n");
}

/**
 * Helper: run search with a fake client and capture stdout in data mode.
 * Returns the parsed JSON array.
 */
async function searchJson(query, options, resultsByCall) {
  const client = makeScriptedClient(resultsByCall);
  return withKey(async () => {
    setOutputMode("data");
    const restoreErr = silenceStderr();
    const getStdout = captureStdout();
    await search(query, options, { clientFactory: singletonFactory(client) });
    restoreErr();
    return extractSearchJson(getStdout());
  });
}

describe("search command — rank assignment and field projection (single query)", () => {
  it("assigns ranks starting at 1 and projects title/url/summary/source/date", async () => {
    const parsed = await searchJson("alpha", {}, [
      [
        {
          refer: "r",
          title: "Alpha",
          link: "https://example.com/a",
          media: "example.com",
          content: "First summary",
          icon: "",
          publish_date: "2025-01-01",
        },
        {
          refer: "r",
          title: "Beta",
          link: "https://example.com/b",
          media: "example.com",
          content: "Second summary",
          icon: "",
        },
      ],
    ]);
    assert.deepStrictEqual(parsed, [
      {
        rank: 1,
        title: "Alpha",
        url: "https://example.com/a",
        summary: "First summary",
        source: "example.com",
        date: "2025-01-01",
      },
      {
        rank: 2,
        title: "Beta",
        url: "https://example.com/b",
        summary: "Second summary",
        source: "example.com",
      },
    ]);
  });

  it("results with no media or publish_date omit source and date", async () => {
    const parsed = await searchJson("x", {}, [
      [
        {
          refer: "r",
          title: "NoMedia",
          link: "https://e/x",
          media: "",
          content: "c",
          icon: "",
        },
      ],
    ]);
    assert.strictEqual(parsed[0].source, undefined);
    assert.strictEqual(parsed[0].date, undefined);
  });
});

describe("search command — summary truncation", () => {
  it("truncates summaries beyond max-summary with ellipsis", async () => {
    const client = makeScriptedClient([
      [
        {
          refer: "r",
          title: "T",
          link: "https://e/x",
          media: "",
          content: "x".repeat(200),
          icon: "",
        },
      ],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("alpha", { maxSummary: 10 }, { clientFactory: singletonFactory(client) });
      restoreErr();
      const parsed = extractSearchJson(getStdout());
      assert.ok(parsed[0].summary.length <= 10);
      assert.match(parsed[0].summary, /…$/);
    });
  });

  it("does not truncate when max-summary is absent", async () => {
    const longText = "y".repeat(100);
    const parsed = await searchJson("x", {}, [
      [
        {
          refer: "r",
          title: "T",
          link: "https://e/x",
          media: "",
          content: longText,
          icon: "",
        },
      ],
    ]);
    assert.strictEqual(parsed[0].summary, longText);
  });
});

describe("search command — field projection", () => {
  it("--fields allowlist restricts JSON output to named keys", async () => {
    const client = makeScriptedClient([
      [
        {
          refer: "r",
          title: "Alpha",
          link: "https://example.com/a",
          media: "example.com",
          content: "First summary",
          icon: "",
        },
      ],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search(
        "alpha",
        { fields: ["title", "url"] },
        {
          clientFactory: singletonFactory(client),
        },
      );
      restoreErr();
      const parsed = extractSearchJson(getStdout());
      assert.deepStrictEqual(parsed, [{ title: "Alpha", url: "https://example.com/a" }]);
    });
  });
});

describe("search command — compact / markdown / refs presentation modes", () => {
  const resultSet = [
    [
      {
        refer: "r",
        title: "Alpha",
        link: "https://example.com/a",
        media: "example.com",
        content: "First summary",
        icon: "",
      },
      {
        refer: "r",
        title: "Beta",
        link: "https://example.com/b",
        media: "example.com",
        content: "Second summary",
        icon: "",
      },
    ],
  ];

  it("compact mode: 'title — url' per line", async () => {
    const client = makeScriptedClient(resultSet);
    await withKey(async () => {
      setOutputMode("compact");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("alpha", {}, { clientFactory: singletonFactory(client) });
      restoreErr();
      const text = extractSearchText(getStdout());
      assert.strictEqual(text, "Alpha — https://example.com/a\nBeta — https://example.com/b");
    });
  });

  it("markdown mode: numbered links with summaries", async () => {
    const client = makeScriptedClient(resultSet);
    await withKey(async () => {
      setOutputMode("markdown");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("alpha", {}, { clientFactory: singletonFactory(client) });
      restoreErr();
      const text = extractSearchText(getStdout());
      assert.ok(text.includes("1. [Alpha](https://example.com/a)"));
      assert.ok(text.includes("First summary"));
    });
  });

  it("refs mode: citation lines", async () => {
    const client = makeScriptedClient(resultSet);
    await withKey(async () => {
      setOutputMode("refs");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("alpha", {}, { clientFactory: singletonFactory(client) });
      restoreErr();
      const text = extractSearchText(getStdout());
      assert.ok(text.includes("[1]"));
      assert.ok(text.includes("Alpha — https://example.com/a"));
    });
  });
});

describe("search command — merge: exact-URL dedupe and occurrence ranking", () => {
  it("dedupes overlapping URLs and ranks by occurrence then best position", async () => {
    const client = makeScriptedClient([
      [
        {
          refer: "r",
          title: "A1",
          link: "https://e/shared",
          media: "",
          content: "shared A",
          icon: "",
        },
        {
          refer: "r",
          title: "A2",
          link: "https://e/only-a",
          media: "",
          content: "only A",
          icon: "",
        },
      ],
      [
        {
          refer: "r",
          title: "B1",
          link: "https://e/shared",
          media: "",
          content: "shared B",
          icon: "",
        },
        {
          refer: "r",
          title: "B2",
          link: "https://e/only-b",
          media: "",
          content: "only B",
          icon: "",
        },
      ],
      [
        {
          refer: "r",
          title: "C1",
          link: "https://e/only-c",
          media: "",
          content: "only C",
          icon: "",
        },
      ],
    ]);

    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("a|b|c", { merge: true }, { clientFactory: singletonFactory(client) });
      restoreErr();
      const parsed = extractSearchJson(getStdout());

      const shared = parsed.find((r) => r.url === "https://e/shared");
      assert.strictEqual(shared.occurrences, 2);
      // Earliest query's title/summary wins for a deduped URL.
      assert.strictEqual(shared.title, "A1");
      assert.strictEqual(shared.summary, "shared A");
      // Shared URL has bestPos 1 across two queries → rank 1.
      assert.strictEqual(parsed[0].url, "https://e/shared");
      // Single-occurrence results in merge mode carry occurrences: 1.
      const onlyA = parsed.find((r) => r.url === "https://e/only-a");
      assert.strictEqual(onlyA.occurrences, 1);
    });
  });

  it("escaped pipes do not split, and empty fragments are dropped", async () => {
    // First: escaped pipe keeps the pipe literal in a single query.
    const client1 = makeScriptedClient([
      [{ refer: "r", title: "T", link: "https://e/x", media: "", content: "c", icon: "" }],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      const escaped = String.raw`a\|b`;
      await search(escaped, { merge: true }, { clientFactory: singletonFactory(client1) });
      restoreErr();
      getStdout();
      assert.strictEqual(client1.calls.length, 1);
      assert.strictEqual(client1.calls[0].query, "a|b");
    });

    // Second: empty fragments are dropped, leaving two real sub-queries.
    const client2 = makeScriptedClient([
      [{ refer: "r", title: "T", link: "https://e/x", media: "", content: "c", icon: "" }],
      [{ refer: "r", title: "T2", link: "https://e/y", media: "", content: "c", icon: "" }],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("a||b|", { merge: true }, { clientFactory: singletonFactory(client2) });
      restoreErr();
      getStdout();
      assert.strictEqual(client2.calls.length, 2);
    });
  });

  it("occurrence badge appears only when occurrences > 1", async () => {
    const client = makeScriptedClient([
      [
        {
          refer: "r",
          title: "Shared",
          link: "https://e/s",
          media: "",
          content: "c",
          icon: "",
        },
      ],
      [
        {
          refer: "r",
          title: "Shared2",
          link: "https://e/s",
          media: "",
          content: "c2",
          icon: "",
        },
        {
          refer: "r",
          title: "Solo",
          link: "https://e/solo",
          media: "",
          content: "c3",
          icon: "",
        },
      ],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("a|b", { merge: true }, { clientFactory: singletonFactory(client) });
      restoreErr();
      const parsed = extractSearchJson(getStdout());
      const shared = parsed.find((r) => r.url === "https://e/s");
      const solo = parsed.find((r) => r.url === "https://e/solo");
      assert.strictEqual(shared.occurrences, 2);
      assert.strictEqual(solo.occurrences, 1);
    });
  });
});

describe("search command — concurrent clients and lifecycle", () => {
  it("merge creates one client per sub-query and closes all of them", async () => {
    const created = [];
    const closed = [];
    const fakeFactory = () => {
      const c = {
        async webSearch() {
          await new Promise((r) => setTimeout(r, 5));
          return [
            {
              refer: "r",
              title: "t",
              link: "https://e/" + Math.random(),
              media: "",
              content: "c",
              icon: "",
            },
          ];
        },
        async close() {
          closed.push(c);
        },
      };
      created.push(c);
      return c;
    };

    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("a|b|c", { merge: true }, { clientFactory: fakeFactory });
      restoreErr();
      getStdout();
      assert.strictEqual(created.length, 3);
      assert.strictEqual(closed.length, 3);
    });
  });

  it("single-query path creates and closes one client", async () => {
    let created = 0;
    let closed = 0;
    const fakeFactory = () => {
      created += 1;
      return {
        async webSearch() {
          return [
            {
              refer: "r",
              title: "t",
              link: "https://e/x",
              media: "",
              content: "c",
              icon: "",
            },
          ];
        },
        async close() {
          closed += 1;
        },
      };
    };

    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("only", {}, { clientFactory: fakeFactory });
      restoreErr();
      getStdout();
      assert.strictEqual(created, 1);
      assert.strictEqual(closed, 1);
    });
  });

  it("all clients close on failure", async () => {
    const closed = [];
    const fakeFactory = () => {
      const c = {
        async webSearch() {
          throw new Error("provider failure");
        },
        async close() {
          closed.push(c);
        },
      };
      return c;
    };

    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      // search() calls process.exit(1) on error — intercept it.
      const originalExit = process.exit;
      process.exit = (code) => {
        throw new Error(`__exit_${code}__`);
      };
      try {
        await search("a|b", { merge: true }, { clientFactory: fakeFactory });
        assert.fail("should have exited");
      } catch (e) {
        assert.match(e.message, /__exit_1__/);
      } finally {
        process.exit = originalExit;
        restoreErr();
        getStdout();
      }
      assert.strictEqual(closed.length, 2);
    });
  });
});

describe("search command — transitional assertion: count enters Z.AI request", () => {
  // P0-02 records that count is currently passed through to the client
  // request. P2-05 replaces this with local truncation after normalization.
  it("count is forwarded to client.webSearch (transitional — replaced in P2-05)", async () => {
    const client = makeScriptedClient([
      [{ refer: "r", title: "T", link: "https://e/x", media: "", content: "c", icon: "" }],
    ]);
    await withKey(async () => {
      setOutputMode("data");
      const restoreErr = silenceStderr();
      const getStdout = captureStdout();
      await search("alpha", { count: 7 }, { clientFactory: singletonFactory(client) });
      restoreErr();
      getStdout();
      assert.strictEqual(client.calls[0].count, 7);
    });
  });
});
