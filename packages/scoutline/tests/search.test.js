/**
 * Search command characterization tests (P1-04 — returned CommandResult).
 *
 * P0-02 captured shipped behaviour of the search command. P1-04 replaces
 * stdout-capture assertions with assertions on the returned
 * {@link CommandResult}: `data` carries the data-mode payload and
 * `presentations` carries the four text-mode overrides. The transitional
 * assertion that `count` currently enters the Z.AI client request (to be
 * replaced with local truncation in P2-05) is preserved.
 *
 * Tests inject the SearchDependencies.clientFactory seam to avoid any
 * network or UTCP construction. The injected fake must expose webSearch()
 * and close(). Notices produced via context.notice() are captured with a
 * stub CommandContext so the merge-info path can be asserted without
 * subprocess streams.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { search } from "../dist/commands/search.js";

const REAL_KEY = "test-key";

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
 * Run search with a fake client and a stub invocation context, returning
 * the CommandResult and any captured notices.
 */
async function searchResult(query, options, resultsByCall) {
  const client = makeScriptedClient(resultsByCall);
  const notices = [];
  const context = {
    stdinIsTTY: false,
    readStdin: async () => "",
    notice: (msg) => notices.push(msg),
  };
  const result = await withKey(async () =>
    search(query, options, { clientFactory: singletonFactory(client) }, context),
  );
  return { result, client, notices };
}

describe("search command — returned data result (rank assignment and field projection)", () => {
  it("assigns ranks starting at 1 and projects title/url/summary/source/date", async () => {
    const { result } = await searchResult("alpha", {}, [
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
    assert.strictEqual(result.kind, "data");
    assert.deepStrictEqual(result.data, [
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
    const { result } = await searchResult("x", {}, [
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
    assert.strictEqual(result.data[0].source, undefined);
    assert.strictEqual(result.data[0].date, undefined);
  });
});

describe("search command — summary truncation", () => {
  it("truncates summaries beyond max-summary with ellipsis", async () => {
    const { result } = await searchResult("alpha", { maxSummary: 10 }, [
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
    assert.ok(result.data[0].summary.length <= 10);
    assert.match(result.data[0].summary, /…$/);
  });

  it("does not truncate when max-summary is absent", async () => {
    const longText = "y".repeat(100);
    const { result } = await searchResult("x", {}, [
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
    assert.strictEqual(result.data[0].summary, longText);
  });
});

describe("search command — field projection", () => {
  it("--fields allowlist restricts the data payload to named keys", async () => {
    const { result } = await searchResult(
      "alpha",
      { fields: ["title", "url"] },
      [
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
      ],
    );
    assert.deepStrictEqual(result.data, [{ title: "Alpha", url: "https://example.com/a" }]);
  });
});

describe("search command — text presentation overrides", () => {
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

  it("compact presentation is 'title — url' per line", async () => {
    const { result } = await searchResult("alpha", {}, resultSet);
    assert.strictEqual(
      result.presentations.compact,
      "Alpha — https://example.com/a\nBeta — https://example.com/b",
    );
  });

  it("markdown presentation is numbered links with summaries", async () => {
    const { result } = await searchResult("alpha", {}, resultSet);
    assert.ok(result.presentations.markdown.includes("1. [Alpha](https://example.com/a)"));
    assert.ok(result.presentations.markdown.includes("First summary"));
  });

  it("refs presentation is citation-style lines", async () => {
    const { result } = await searchResult("alpha", {}, resultSet);
    assert.ok(result.presentations.refs.includes("[1]"));
    assert.ok(result.presentations.refs.includes("Alpha — https://example.com/a"));
  });

  it("tty presentation is the human-friendly formatted block", async () => {
    const { result } = await searchResult("alpha", {}, resultSet);
    // TTY presentation should contain both titles (no exact format guarantee
    // beyond "includes the page titles and URLs").
    assert.ok(result.presentations.tty.includes("Alpha"));
    assert.ok(result.presentations.tty.includes("https://example.com/a"));
    assert.ok(result.presentations.tty.includes("Beta"));
  });

  it("empty results yield empty compact and markdown presentations", async () => {
    const { result } = await searchResult("alpha", {}, [[]]);
    assert.deepStrictEqual(result.data, []);
    assert.strictEqual(result.presentations.compact, "");
    assert.strictEqual(result.presentations.markdown, "");
    assert.strictEqual(result.presentations.refs, "");
  });
});

describe("search command — merge: exact-URL dedupe and occurrence ranking", () => {
  it("dedupes overlapping URLs and ranks by occurrence then best position", async () => {
    const { result } = await searchResult(
      "a|b|c",
      { merge: true },
      [
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
      ],
    );

    const shared = result.data.find((r) => r.url === "https://e/shared");
    assert.strictEqual(shared.occurrences, 2);
    // Earliest query's title/summary wins for a deduped URL.
    assert.strictEqual(shared.title, "A1");
    assert.strictEqual(shared.summary, "shared A");
    // Shared URL has bestPos 1 across two queries → rank 1.
    assert.strictEqual(result.data[0].url, "https://e/shared");
    // Single-occurrence results in merge mode carry occurrences: 1.
    const onlyA = result.data.find((r) => r.url === "https://e/only-a");
    assert.strictEqual(onlyA.occurrences, 1);
  });

  it("escaped pipes do not split, and empty fragments are dropped", async () => {
    // First: escaped pipe keeps the pipe literal in a single query.
    const client1 = makeScriptedClient([
      [{ refer: "r", title: "T", link: "https://e/x", media: "", content: "c", icon: "" }],
    ]);
    await withKey(async () => {
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      const escaped = String.raw`a\|b`;
      await search(
        escaped,
        { merge: true },
        { clientFactory: singletonFactory(client1) },
        context,
      );
      assert.strictEqual(client1.calls.length, 1);
      assert.strictEqual(client1.calls[0].query, "a|b");
    });

    // Second: empty fragments are dropped, leaving two real sub-queries.
    const client2 = makeScriptedClient([
      [{ refer: "r", title: "T", link: "https://e/x", media: "", content: "c", icon: "" }],
      [{ refer: "r", title: "T2", link: "https://e/y", media: "", content: "c", icon: "" }],
    ]);
    await withKey(async () => {
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      await search(
        "a||b|",
        { merge: true },
        { clientFactory: singletonFactory(client2) },
        context,
      );
      assert.strictEqual(client2.calls.length, 2);
    });
  });

  it("occurrence badge appears only when occurrences > 1", async () => {
    const { result } = await searchResult(
      "a|b",
      { merge: true },
      [
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
      ],
    );
    const shared = result.data.find((r) => r.url === "https://e/s");
    const solo = result.data.find((r) => r.url === "https://e/solo");
    assert.strictEqual(shared.occurrences, 2);
    assert.strictEqual(solo.occurrences, 1);
  });

  it("merge emits a context.notice summarizing the merge", async () => {
    const { notices } = await searchResult(
      "rust|rust tokio|rust runtime",
      { merge: true },
      [
        [
          { refer: "r", title: "R1", link: "https://e/r1", media: "", content: "c", icon: "" },
        ],
        [
          { refer: "r", title: "R2", link: "https://e/r2", media: "", content: "c", icon: "" },
        ],
        [
          { refer: "r", title: "R3", link: "https://e/r3", media: "", content: "c", icon: "" },
        ],
      ],
    );
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0], /merged 3 queries/);
    assert.match(notices[0], /3 unique results/);
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
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      await search("a|b|c", { merge: true }, { clientFactory: fakeFactory }, context);
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
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      await search("only", {}, { clientFactory: fakeFactory }, context);
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
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      let caught = null;
      try {
        await search("a|b", { merge: true }, { clientFactory: fakeFactory }, context);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof Error, "search should throw on failure");
      assert.match(caught.message, /provider failure/);
      assert.strictEqual(closed.length, 2);
    });
  });

  it("single-query failure closes the one client", async () => {
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
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      let caught = null;
      try {
        await search("only", {}, { clientFactory: fakeFactory }, context);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof Error);
      assert.strictEqual(closed.length, 1);
    });
  });
});

describe("search command — empty merge input throws", () => {
  it("--merge with only empty fragments throws without invoking the client", async () => {
    const client = makeScriptedClient([[]]);
    let caught = null;
    await withKey(async () => {
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      try {
        await search(
          "|||",
          { merge: true },
          { clientFactory: singletonFactory(client) },
          context,
        );
      } catch (e) {
        caught = e;
      }
    });
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /merge requires at least one non-empty query/);
    assert.strictEqual(client.calls.length, 0);
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
      const context = {
        stdinIsTTY: false,
        readStdin: async () => "",
        notice: () => {},
      };
      await search(
        "alpha",
        { count: 7 },
        { clientFactory: singletonFactory(client) },
        context,
      );
      assert.strictEqual(client.calls[0].count, 7);
    });
  });
});
