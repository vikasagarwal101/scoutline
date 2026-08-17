/**
 * Test helper: createFakeAdapter — a ProviderAdapter double that records
 * every Capability invocation. Each omitted Capability method is wired up
 * to throw so an unexpected call fails the test instead of silently returning
 * undefined.
 *
 * P6-08 extends this file with a reusable fake Repository Capability
 * (`createFakeRepositoryCapability`) and a matching fake Provider
 * Descriptor (`createFakeRepositoryDescriptor`). Both produce the SAME
 * normalized contract as the Z.AI Adapter WITHOUT touching any ZRead
 * grammar; they are the cross-Adapter conformance proof.
 *
 * Fresh-state contract (6.10):
 *   Each call to `createFakeAdapter` (and every `createFake*` helper in
 *   this file) returns a brand-new object graph: fresh `calls` arrays,
 *   fresh `stats` counters, fresh scripted results. There is NO shared
 *   mutable state across calls. A test that needs a fake adapter calls
 *   `createFakeAdapter(...)` at the top of its test body — never reuses
 *   a module-level instance. Adding shared module-level state (e.g. a
 *   singleton `calls` array) would silently affect 3+ conformance suites
 *   (`adapter-conformance`, `reader-conformance`, `repository-conformance`)
 *   that each call `createFakeAdapter` / `createFakeRepositoryCapability` /
 *   `createFakeReaderCapability` independently and rely on zero cross-test
 *   bleed. If a reset mechanism is ever needed, it must be opt-in and must
 *   not change the default fresh-object-graph behaviour.
 */
import crypto from "node:crypto";

import {
  decodeRepositoryDirectoryListing,
  decodeRepositoryFile,
  decodeRepositorySearch,
} from "../../dist/capabilities/repository.js";
import { decodeReaderFetchResult } from "../../dist/capabilities/reader.js";
import { decodeCrawlResult } from "../../dist/capabilities/crawl.js";
import { decodeMapResult } from "../../dist/capabilities/map.js";
import { decodeResearchResult } from "../../dist/capabilities/research.js";
import { ValidationError } from "../../dist/lib/errors.js";

export function createFakeAdapter(overrides = {}) {
  const calls = {
    search: [],
    vision: [],
    quota: [],
    diagnostics: [],
  };

  const mustOverride = (name) => {
    throw new Error(
      `FakeAdapter was invoked for "${name}" but no override was provided. ` +
        `Provide createFakeAdapter({ ${name}: () => ... }) for this test.`,
    );
  };

  const adapter = {
    id: overrides.id || "fake",
    capabilities: () => overrides.capabilities || new Set(),
    async search(request) {
      calls.search.push(request);
      if (typeof overrides.search === "function") {
        return overrides.search(request);
      }
      mustOverride("search");
    },
    async visionInterpretImage(request) {
      calls.vision.push(request);
      if (typeof overrides.visionInterpretImage === "function") {
        return overrides.visionInterpretImage(request);
      }
      mustOverride("visionInterpretImage");
    },
    async quota() {
      calls.quota.push({});
      if (typeof overrides.quota === "function") {
        return overrides.quota();
      }
      mustOverride("quota");
    },
    async diagnostics() {
      calls.diagnostics.push({});
      if (typeof overrides.diagnostics === "function") {
        return overrides.diagnostics();
      }
      mustOverride("diagnostics");
    },
    async close() {
      return Promise.resolve();
    },
  };

  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// P6-08: fake Repository Capability (DESIGN.md §18, PRD FR-080–FR-093).
//
// A reusable second Repository Adapter that produces the SAME normalized
// contract as the Z.AI Adapter WITHOUT touching any ZRead grammar. It is
// the cross-Adapter conformance proof: the same semantic request flows
// through Z.AI (fed a raw grammar fixture) and the fake (fed the structured
// expected result) and produces identical normalized `RepositorySearchResult`
// / `RepositoryFileResult` / `RepositoryDirectoryListing` values.
//
// Scope:
//   - Returns structured normalized results directly; NO raw text parsing.
//   - Records every `validate` / `cacheIdentity` / `decodeCached` / `invoke`
//     call so conformance tests can assert lifecycle, ordering, and
//     attempt counts.
//   - Accepts a resolved credential (used for the cache fingerprint) and
//     optional Adapter-owned legacy candidates.
//   - Accepts a scripted `error` (Error or function(attempt) => Error) and
//     a scripted `result` (value or function(request, attempt) => value)
//     per operation for retry and error-taxonomy proofs.
//
// What this helper is NOT:
//   - It has NO transport and performs NO close. The authoritative close
//     lifecycle evidence lives in `repository-conformance.test.js`, which
//     drives the REAL Z.AI Adapter through fake per-port doubles that
//     record `closeEntered` and `fake.closeCount`. Do not add close-
//     related fields here; the Z.AI per-port doubles are the lifecycle
//     source of truth.
//   - Its `legacyCandidates` are GENERIC executor-ordering fixtures only.
//     They do NOT model the real Z.AI `ZAI_API_KEY` credential alias; the
//     real alias matrix lives in `repository-conformance.test.js` and
//     drives the production Z.AI Adapter end-to-end.
//
// This helper is test-only and exports no production code. It never imports
// a concrete Provider, transport, or command module.
// ---------------------------------------------------------------------------

/**
 * Build a fake Repository Capability. Each operation returns a scripted
 * structured result. Pass per-operation overrides to script errors or
 * custom results.
 *
 * @param {object} options
 * @param {string} options.apiKey
 *   Resolved credential used for the cache fingerprint. The fingerprint
 *   matches the Z.AI Adapter algorithm (full SHA-256 hex) so cross-Adapter
 *   cache-key identity proofs can compare apples to apples.
 * @param {("zai"|"minimax"|"fake")} [options.provider="fake"]
 *   Provider ID embedded in the cache identity. Defaults to `"fake"` so
 *   cross-Provider cache isolation can be asserted without colliding with
 *   the built-in IDs.
 * @param {object} [options.search]
 *   Per-operation script for Search. Shape: `{ result?, error? }`.
 *   `result` may be a `RepositorySearchResult` value or a function
 *   `(request, attempt) => RepositorySearchResult`. `error` may be an
 *   `Error` instance or a function `(attempt) => Error`. When `error`
 *   is set it takes precedence over `result`. The fake has no transport
 *   and performs no close; this option scripts only the visible
 *   `invoke()` outcome.
 * @param {object} [options.readFile]
 *   Same shape as `search`, for the File operation.
 * @param {object} [options.listDirectory]
 *   Same shape as `search`, for the Directory operation. `result` may
 *   be a function of `request` so BFS proofs can return path-dependent
 *   listings.
 * @param {object[]} [options.legacyCandidates]
 *   Generic executor-ordering fixtures attached to every operation's
 *   `cacheIdentity`. Each entry: `{ key, decode }`. The decode runs
 *   against the raw cached value and returns the normalized result or
 *   `null`. These fixtures exercise the shared executor's candidate-
 *   sequence behaviour (primary-before-alias `cache.get` order,
 *   write-through to the normalized key, fall-through to invoke on
 *   miss); they do NOT model the real Z.AI `ZAI_API_KEY` credential
 *   alias, which is covered end-to-end through the production Z.AI
 *   Adapter in `repository-conformance.test.js`.
 * @returns {{capability: object, stats: object, fingerprint: string}}
 *   `capability` is a `RepositoryCapability`. `stats` exposes per-
 *   operation counters: `{ validate, cacheIdentity, decodeCached,
 *   invoke, lastRequest }` for `search`, `readFile`, and
 *   `listDirectory`. `fingerprint` is the full SHA-256 hex digest of
 *   the resolved credential (matching the Z.AI Adapter algorithm).
 *   There is NO `invokeCount` or `closes` field; use
 *   `stats.<operation>.invoke` for attempt counts and the Z.AI per-
 *   port doubles in `repository-conformance.test.js` for close
 *   evidence.
 */
export function createFakeRepositoryCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const provider = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const legacyCandidates = options.legacyCandidates || [];

  const stats = {
    search: { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null },
    readFile: { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null },
    listDirectory: { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null },
  };

  function makeOperation(kind, label, scripted, decoder) {
    return {
      kind,
      validate(request) {
        stats[label].validate += 1;
        // Mirror the Z.AI Adapter's structural validation: repository must
        // contain a slash; query must contain non-whitespace; File path
        // must be non-empty; Directory path may be empty (root).
        if (typeof request.repository !== "string" || !request.repository.includes("/")) {
          throw new ValidationError("fake repository must be 'owner/name'");
        }
        if (kind === "repository-search") {
          if (typeof request.query !== "string" || request.query.trim().length === 0) {
            throw new ValidationError("fake search query must contain non-whitespace text");
          }
          if (request.language !== "en" && request.language !== "zh") {
            throw new ValidationError("fake search language must be 'en' or 'zh'");
          }
        } else if (kind === "repository-read-file") {
          if (typeof request.path !== "string" || request.path.length === 0) {
            throw new ValidationError("fake File path must be non-empty");
          }
        } else if (kind === "repository-list-directory") {
          if (typeof request.path !== "string") {
            throw new ValidationError("fake Directory path must be a string");
          }
        }
      },
      cacheIdentity(request) {
        stats[label].cacheIdentity += 1;
        stats[label].lastRequest = request;
        return {
          provider,
          capability: "repository-exploration",
          operation: kind,
          credentialFingerprint: fingerprint,
          request,
          legacyCandidates,
        };
      },
      decodeCached(value) {
        stats[label].decodeCached += 1;
        return decoder(value);
      },
      async invoke(request) {
        stats[label].invoke += 1;
        stats[label].lastRequest = request;
        if (scripted && typeof scripted.error === "function") {
          throw scripted.error(stats[label].invoke);
        }
        if (scripted && scripted.error instanceof Error) {
          throw scripted.error;
        }
        if (scripted && typeof scripted.result === "function") {
          return scripted.result(request, stats[label].invoke);
        }
        if (scripted && scripted.result !== undefined) {
          return scripted.result;
        }
        throw new Error(
          `fake Repository operation "${kind}" invoke called without a scripted result/error`,
        );
      },
    };
  }

  const capability = {
    search: makeOperation("repository-search", "search", options.search, decodeRepositorySearch),
    readFile: makeOperation(
      "repository-read-file",
      "readFile",
      options.readFile,
      decodeRepositoryFile,
    ),
    listDirectory: makeOperation(
      "repository-list-directory",
      "listDirectory",
      options.listDirectory,
      decodeRepositoryDirectoryListing,
    ),
  };

  return { capability, stats, fingerprint };
}

/**
 * Build a fake Provider Descriptor whose created Adapter exposes a fake
 * Repository Capability. The descriptor ALWAYS advertises
 * `repository-exploration` (the capability set starts from
 * `["repository-exploration"]` and `extraCapabilities` is additive on
 * top of it; there is no opt-out). `omitRepositoryOnAdapter: true`
 * creates the descriptor/Adapter mismatch case used by fail-closed
 * dispatch proofs: `capabilities()` still advertises the capability,
 * but `create()` returns an Adapter WITHOUT the `repository` handle.
 * This is the descriptor shape `main()` consumes; it never touches a
 * real transport.
 *
 * @param {object} opts
 * @param {string} [opts.id="fake"]
 *   Provider ID embedded in the cache identity.
 * @param {string} [opts.apiKey="fake-adapter-key"]
 *   Resolved credential forwarded to `createFakeRepositoryCapability`.
 * @param {boolean|((env) => boolean)} [opts.configured=true]
 *   Either a static configured flag or a function evaluated against
 *   the env passed to `isConfigured()`.
 * @param {object} [opts.capabilityOptions={}]
 *   Forwarded verbatim to `createFakeRepositoryCapability` as the
 *   per-operation script (`search`/`readFile`/`listDirectory`/
 *   `legacyCandidates`).
 * @param {string[]} [opts.extraCapabilities=[]]
 *   Additive capability IDs joined onto the always-present
 *   `repository-exploration` base.
 * @param {boolean} [opts.omitRepositoryOnAdapter=false]
 *   When `true`, `create()` returns an Adapter without the `repository`
 *   handle even though `capabilities()` still advertises
 *   `repository-exploration`. Used to exercise the dispatcher's
 *   fail-closed path.
 * @returns {{descriptor: object, stats: object}}
 *   `descriptor` is a `ProviderDescriptor`. `stats` exposes
 *   `{ isConfiguredCalls, capabilitiesCalls, createCalls }`.
 */
export function createFakeRepositoryDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitRepositoryOnAdapter = false,
} = {}) {
  const stats = {
    isConfiguredCalls: 0,
    capabilitiesCalls: 0,
    createCalls: 0,
  };
  const baseCapabilities = new Set(["repository-exploration", ...extraCapabilities]);
  const descriptor = {
    id,
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(baseCapabilities);
    },
    create() {
      stats.createCalls += 1;
      const adapter = { id };
      if (!omitRepositoryOnAdapter) {
        const { capability } = createFakeRepositoryCapability({
          apiKey,
          provider: id,
          ...capabilityOptions,
        });
        adapter.repository = capability;
        adapter._fakeStats = stats;
      }
      return adapter;
    },
  };
  return { descriptor, stats };
}

// ---------------------------------------------------------------------------
// Reader Migration 05: fake Reader Capability (DESIGN.md §18).
//
// A reusable second Reader Adapter that produces the SAME normalized
// `ReaderFetchResult` contract as the Z.AI Reader Adapter WITHOUT
// touching any WebReader raw response. It is the cross-Adapter
// conformance proof: the same semantic request flows through Z.AI
// (fed a raw WebReader object fixture) and the fake (fed the
// structured expected result) and produces identical normalized
// `ReaderFetchResult` values.
//
// Scope:
//   - Returns a structured normalized result directly; NO raw parsing.
//   - Records every `validate` / `cacheIdentity` / `decodeCached` /
//     `invoke` call so conformance tests can assert lifecycle,
//     ordering, and attempt counts.
//   - Accepts a resolved credential (used for the cache fingerprint)
//     and optional Adapter-owned legacy candidates.
//   - Accepts a scripted `fetchResult` (constant ReaderFetchResult or
//     function (request, attempt) => ReaderFetchResult) and a scripted
//     `fetchError` (Error or function (attempt) => Error) per call for
//     retry and error-taxonomy proofs.
//   - Accepts a `closeBehavior` ("resolve" | "reject" | "hang") stored
//     on the stats object so conformance tests can inspect what close
//     shape the fake Adapter would have requested. The authoritative
//     close lifecycle evidence (closeEntered / fake.closeCount) lives
//     in `reader-conformance.test.js`, which drives the REAL Z.AI
//     Adapter through fake per-port doubles. The fake has no transport
//     of its own; this field is inspection-only.
//
// What this helper is NOT:
//   - It has NO transport and performs NO real close. The Z.AI per-port
//     doubles in `reader-conformance.test.js` are the lifecycle source
//     of truth, exactly mirroring the P6-08 repository precedent. Do
//     not add close-related call counters here.
//   - Its `legacyCandidates` are GENERIC executor-ordering fixtures
//     only. They do NOT model the real Z.AI `ZAI_API_KEY` credential
//     alias; the real alias matrix lives in `reader-conformance.test.js`
//     and drives the production Z.AI Adapter end-to-end.
//
// This helper is test-only and exports no production code. It never
// imports a concrete Provider, transport, or command module.
// ---------------------------------------------------------------------------

/**
 * Build a fake Reader Capability. The single `fetch` operation returns
 * a scripted structured result. Pass per-operation overrides to script
 * errors or custom results.
 *
 * @param {object} options
 * @param {string} [options.apiKey="fake-adapter-key"]
 *   Resolved credential used for the cache fingerprint. The fingerprint
 *   matches the Z.AI Adapter algorithm (full SHA-256 hex) so cross-
 *   Adapter cache-key identity proofs can compare apples to apples.
 * @param {("zai"|"minimax"|"fake")} [options.provider="fake"]
 *   Provider ID embedded in the cache identity. Defaults to `"fake"`
 *   so cross-Provider cache isolation can be asserted without
 *   colliding with the built-in IDs.
 * @param {object} [options.fetch]
 *   Per-operation script for Fetch. Shape: `{ result?, error? }`.
 *   `result` may be a `ReaderFetchResult` value or a function
 *   `(request, attempt) => ReaderFetchResult`. `error` may be an
 *   `Error` instance or a function `(attempt) => Error`. When `error`
 *   is set it takes precedence over `result`. The fake has no transport
 *   and performs no close; this option scripts only the visible
 *   `invoke()` outcome.
 * @param {object[]} [options.legacyCandidates]
 *   Generic executor-ordering fixtures attached to the fetch
 *   operation's `cacheIdentity`. Each entry: `{ key, decode }`. The
 *   decode runs against the raw cached value and returns the
 *   normalized result or `null`. These fixtures exercise the shared
 *   executor's candidate-sequence behaviour (primary-before-alias
 *   `cache.get` order, write-through to the normalized key, fall-
 *   through to invoke on miss); they do NOT model the real Z.AI
 *   `ZAI_API_KEY` credential alias, which is covered end-to-end
 *   through the production Z.AI Adapter in
 *   `reader-conformance.test.js`.
 * @param {("resolve"|"reject"|"hang")} [options.closeBehavior="resolve"]
 *   Inspection-only flag stored on the returned `stats` object. The
 *   fake has no transport; close lifecycle evidence comes from the
 *   Z.AI per-port doubles in `reader-conformance.test.js`. This field
 *   is provided so conformance tests can assert the scripted close
 *   shape alongside the real Adapter's per-port evidence.
 * @returns {{capability: object, stats: object, fingerprint: string}}
 *   `capability` is a `ReaderCapability`. `stats` exposes per-
 *   operation counters: `{ validate, cacheIdentity, decodeCached,
 *   invoke, lastRequest, closeBehavior }`. `fingerprint` is the full
 *   SHA-256 hex digest of the resolved credential (matching the Z.AI
 *   Adapter algorithm).
 */
export function createFakeReaderCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const provider = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const legacyCandidates = options.legacyCandidates || [];
  const scripted = options.fetch || {};
  const closeBehavior = options.closeBehavior || "resolve";

  const stats = {
    fetch: {
      validate: 0,
      cacheIdentity: 0,
      decodeCached: 0,
      invoke: 0,
      lastRequest: null,
    },
    closeBehavior,
  };

  const operation = {
    kind: "reader-fetch",
    validate(request) {
      stats.fetch.validate += 1;
      // Mirror the Z.AI Adapter's structural validation: URL must be
      // a non-empty string starting with http:// or https://.
      if (typeof request.url !== "string" || request.url.length === 0) {
        throw new ValidationError("fake reader URL must be a non-empty string");
      }
      if (!/^https?:\/\//.test(request.url)) {
        throw new ValidationError("URL must start with http:// or https://");
      }
    },
    cacheIdentity(request) {
      stats.fetch.cacheIdentity += 1;
      stats.fetch.lastRequest = request;
      return {
        provider,
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: fingerprint,
        request,
        legacyCandidates,
      };
    },
    decodeCached(value) {
      stats.fetch.decodeCached += 1;
      return decodeReaderFetchResult(value);
    },
    async invoke(request) {
      stats.fetch.invoke += 1;
      stats.fetch.lastRequest = request;
      if (typeof scripted.error === "function") {
        throw scripted.error(stats.fetch.invoke);
      }
      if (scripted.error instanceof Error) {
        throw scripted.error;
      }
      if (typeof scripted.result === "function") {
        return scripted.result(request, stats.fetch.invoke);
      }
      if (scripted.result !== undefined) {
        return scripted.result;
      }
      throw new Error(
        "fake Reader fetch invoke called without a scripted result/error",
      );
    },
  };

  const capability = { fetch: operation };
  return { capability, stats, fingerprint };
}

/**
 * Build a fake Provider Descriptor whose created Adapter exposes a fake
 * Reader Capability. The descriptor ALWAYS advertises `reader` (the
 * capability set starts from `["reader"]` and `extraCapabilities` is
 * additive on top of it; there is no opt-out). `omitReaderOnAdapter:
 * true` creates the descriptor/Adapter mismatch case used by fail-
 * closed dispatch proofs: `capabilities()` still advertises the
 * capability, but `create()` returns an Adapter WITHOUT the `reader`
 * handle. This is the descriptor shape `main()` consumes; it never
 * touches a real transport.
 *
 * @param {object} opts
 * @param {string} [opts.id="fake"]
 *   Provider ID embedded in the cache identity.
 * @param {string} [opts.apiKey="fake-adapter-key"]
 *   Resolved credential forwarded to `createFakeReaderCapability`.
 * @param {boolean|((env) => boolean)} [opts.configured=true]
 *   Either a static configured flag or a function evaluated against
 *   the env passed to `isConfigured()`.
 * @param {object} [opts.capabilityOptions={}]
 *   Forwarded verbatim to `createFakeReaderCapability` as the per-
 *   operation script (`fetch`/`legacyCandidates`/`closeBehavior`).
 * @param {string[]} [opts.extraCapabilities=[]]
 *   Additive capability IDs joined onto the always-present `reader`
 *   base.
 * @param {boolean} [opts.omitReaderOnAdapter=false]
 *   When `true`, `create()` returns an Adapter without the `reader`
 *   handle even though `capabilities()` still advertises `reader`.
 *   Used to exercise the dispatcher's fail-closed path.
 * @returns {{descriptor: object, stats: object}}
 *   `descriptor` is a `ProviderDescriptor`. `stats` exposes
 *   `{ isConfiguredCalls, capabilitiesCalls, createCalls }`.
 */
export function createFakeReaderDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitReaderOnAdapter = false,
} = {}) {
  const stats = {
    isConfiguredCalls: 0,
    capabilitiesCalls: 0,
    createCalls: 0,
  };
  const baseCapabilities = new Set(["reader", ...extraCapabilities]);
  const descriptor = {
    id,
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(baseCapabilities);
    },
    create() {
      stats.createCalls += 1;
      const adapter = { id };
      if (!omitReaderOnAdapter) {
        const { capability } = createFakeReaderCapability({
          apiKey,
          provider: id,
          ...capabilityOptions,
        });
        adapter.reader = capability;
        adapter._fakeStats = stats;
      }
      return adapter;
    },
  };
  return { descriptor, stats };
}

// ---------------------------------------------------------------------------
// Usage-ledger Ticket 4: fake Crawl / Map / Research / Search Capabilities
// and Descriptors.
//
// Crawl, map, and research had no shared doubles (the async-fallback and
// Tavily suites hand-build theirs inline); the usage-ledger handler
// threading needs one reusable double per capability mirroring the
// reader/repository pattern in this file: a structured normalized result
// (NO raw parsing), per-operation stats, a scripted result/error pair,
// and a matching Provider Descriptor whose created Adapter exposes the
// capability under its dispatch slot (`adapter.crawl`, `adapter.map`,
// `adapter.research`, `adapter.search`).
//
// The three async capabilities ride the simplified `CachedOperation`
// surface (`validate` / `cacheIdentity` / `decodeCached` / `invoke`, NO
// legacy candidates) consumed by `executeCachedOperation`; the identity's
// `capability` field MUST be the bare capability id ("crawl" / "map" /
// "research") because `executeCachedOperation` uses it BOTH as the
// consumption event's `capabilityId` AND as the `ProviderOperation` that
// drives the default retry policy. Search is NOT a CachedOperation
// (shared execution caches the raw normalized array directly), so the
// search fake has no `decodeCached`.
//
// Scripting superset over the reader/repository fakes: an `error`
// function may return `null`/`undefined` to fall through to `result` on
// that attempt, so "fail once (retryable), then succeed" is scriptable
// without adapter-level state. A constant Error throws on every attempt.
// ---------------------------------------------------------------------------

/**
 * Shared operation body for the three async fakes. `decoder` is the
 * capability's total normalized cache decoder; `validateRequest` mirrors
 * the structural checks the real Adapter performs.
 */
function makeCachedOperation({ kind, providerId, capabilityId, fingerprint, scripted, decoder, stats, validateRequest }) {
  return {
    kind,
    validate(request) {
      stats.validate += 1;
      validateRequest(request);
    },
    cacheIdentity(request) {
      stats.cacheIdentity += 1;
      stats.lastRequest = request;
      return {
        provider: providerId,
        capability: capabilityId,
        credentialFingerprint: fingerprint,
        request,
      };
    },
    decodeCached(value) {
      stats.decodeCached += 1;
      return decoder(value);
    },
    async invoke(request) {
      stats.invoke += 1;
      stats.lastRequest = request;
      if (typeof scripted.error === "function") {
        const error = scripted.error(stats.invoke);
        if (error !== null && error !== undefined) throw error;
      } else if (scripted.error instanceof Error) {
        throw scripted.error;
      }
      if (typeof scripted.result === "function") {
        return scripted.result(request, stats.invoke);
      }
      if (scripted.result !== undefined) {
        return scripted.result;
      }
      throw new Error(
        `fake ${capabilityId} operation "${kind}" invoke called without a scripted result/error`,
      );
    },
  };
}

/**
 * Shared descriptor body for the async + search fakes. Mirrors
 * `createFakeReaderDescriptor` / `createFakeRepositoryDescriptor`: the
 * base capability is always advertised, `extraCapabilities` is additive,
 * and `omitXOnAdapter` builds the descriptor/Adapter mismatch case
 * (advertised but absent on the created Adapter) for fail-closed
 * dispatch proofs. `makeCapability` returns the FULL capability object
 * the Adapter exposes under `adapter[slot]`.
 */
function makeCapabilityDescriptor({
  id,
  configured,
  capabilityId,
  extraCapabilities,
  omitOnAdapter,
  slot,
  makeCapability,
  stats,
}) {
  const descriptor = {
    id,
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set([capabilityId, ...extraCapabilities]);
    },
    create() {
      stats.createCalls += 1;
      const adapter = { id };
      if (!omitOnAdapter) {
        adapter[slot] = makeCapability();
        adapter._fakeStats = stats;
      }
      return adapter;
    },
  };
  return descriptor;
}

/**
 * Build a fake Crawl Capability. The single `fetch` operation returns a
 * scripted normalized `CrawlResult`.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey="fake-adapter-key"]
 * @param {string} [options.provider="fake"]
 * @param {object} [options.fetch]
 *   Script: `{ result?, error? }`. `result` is a `CrawlResult` or
 *   `(request, attempt) => CrawlResult`; `error` is an `Error` or
 *   `(attempt) => Error | null` (null falls through to `result` so
 *   fail-once-then-succeed is scriptable).
 * @returns {{capability: object, stats: object, fingerprint: string}}
 *   `stats` exposes `{ validate, cacheIdentity, decodeCached, invoke,
 *   lastRequest }` for the fetch operation.
 */
export function createFakeCrawlCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const providerId = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const stats = { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null };
  const capability = {
    fetch: makeCachedOperation({
      kind: "crawl-fetch",
      providerId,
      capabilityId: "crawl",
      fingerprint,
      scripted: options.fetch || {},
      decoder: decodeCrawlResult,
      stats,
      validateRequest(request) {
        if (typeof request.url !== "string" || !/^https?:\/\//.test(request.url)) {
          throw new ValidationError("fake crawl URL must start with http:// or https://");
        }
      },
    }),
  };
  return { capability, stats, fingerprint };
}

/**
 * Fake Crawl Provider Descriptor. Always advertises `crawl`; the created
 * Adapter exposes `adapter.crawl.fetch`.
 *
 * @param {object} [opts]
 * @param {string} [opts.id="fake"]
 * @param {string} [opts.apiKey="fake-adapter-key"]
 * @param {boolean|((env) => boolean)} [opts.configured=true]
 * @param {object} [opts.capabilityOptions={}]
 *   Forwarded to `createFakeCrawlCapability` (`fetch`).
 * @param {string[]} [opts.extraCapabilities=[]]
 * @param {boolean} [opts.omitCrawlOnAdapter=false]
 * @returns {{descriptor: object, stats: object}}
 *   `stats` exposes `{ isConfiguredCalls, capabilitiesCalls, createCalls }`.
 */
export function createFakeCrawlDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitCrawlOnAdapter = false,
} = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = makeCapabilityDescriptor({
    id,
    configured,
    capabilityId: "crawl",
    extraCapabilities,
    omitOnAdapter: omitCrawlOnAdapter,
    slot: "crawl",
    makeCapability: () => createFakeCrawlCapability({ apiKey, provider: id, ...capabilityOptions }).capability,
    stats,
  });
  return { descriptor, stats };
}

/**
 * Build a fake Map Capability. The single `fetch` operation returns a
 * scripted normalized `MapResult`. Same script contract as
 * {@link createFakeCrawlCapability}.
 *
 * @returns {{capability: object, stats: object, fingerprint: string}}
 */
export function createFakeMapCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const providerId = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const stats = { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null };
  const capability = {
    fetch: makeCachedOperation({
      kind: "map-fetch",
      providerId,
      capabilityId: "map",
      fingerprint,
      scripted: options.fetch || {},
      decoder: decodeMapResult,
      stats,
      validateRequest(request) {
        if (typeof request.url !== "string" || !/^https?:\/\//.test(request.url)) {
          throw new ValidationError("fake map URL must start with http:// or https://");
        }
      },
    }),
  };
  return { capability, stats, fingerprint };
}

/**
 * Fake Map Provider Descriptor. Always advertises `map`; the created
 * Adapter exposes `adapter.map.fetch`.
 *
 * @returns {{descriptor: object, stats: object}}
 */
export function createFakeMapDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitMapOnAdapter = false,
} = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = makeCapabilityDescriptor({
    id,
    configured,
    capabilityId: "map",
    extraCapabilities,
    omitOnAdapter: omitMapOnAdapter,
    slot: "map",
    makeCapability: () => createFakeMapCapability({ apiKey, provider: id, ...capabilityOptions }).capability,
    stats,
  });
  return { descriptor, stats };
}

/**
 * Build a fake Research Capability. The single `run` operation returns a
 * scripted normalized `ResearchResult`. The fake's `invoke` resolves
 * immediately — it does NOT model the real create→poll lifecycle or the
 * on-disk state file; the handler still computes a state-file path and
 * registers its SIGINT teardown around the fake.
 *
 * @param {object} [options.run]
 *   Script: `{ result?, error? }` (same contract as the crawl fake).
 * @returns {{capability: object, stats: object, fingerprint: string}}
 */
export function createFakeResearchCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const providerId = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const stats = { validate: 0, cacheIdentity: 0, decodeCached: 0, invoke: 0, lastRequest: null };
  const capability = {
    run: makeCachedOperation({
      kind: "research-fetch",
      providerId,
      capabilityId: "research",
      fingerprint,
      scripted: options.run || {},
      decoder: decodeResearchResult,
      stats,
      validateRequest(request) {
        if (typeof request.query !== "string" || request.query.trim().length === 0) {
          throw new ValidationError("fake research query must contain non-whitespace text");
        }
      },
    }),
  };
  return { capability, stats, fingerprint };
}

/**
 * Fake Research Provider Descriptor. Always advertises `research`; the
 * created Adapter exposes `adapter.research.run`.
 *
 * @returns {{descriptor: object, stats: object}}
 */
export function createFakeResearchDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitResearchOnAdapter = false,
} = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = makeCapabilityDescriptor({
    id,
    configured,
    capabilityId: "research",
    extraCapabilities,
    omitOnAdapter: omitResearchOnAdapter,
    slot: "research",
    makeCapability: () => createFakeResearchCapability({ apiKey, provider: id, ...capabilityOptions }).capability,
    stats,
  });
  return { descriptor, stats };
}

/**
 * Build a fake Search Capability usable through dispatch. `validate`
 * rejects an empty query, `cacheIdentity` embeds the Provider id +
 * credential fingerprint, and `invoke` returns a scripted
 * `SearchSource[]`. Search is NOT a `CachedOperation` (shared execution
 * caches the raw normalized array), so there is no `decodeCached`.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey="fake-adapter-key"]
 * @param {string} [options.provider="fake"]
 * @param {object} [options.search]
 *   Script: `{ result?, error? }` (same contract as the crawl fake).
 * @returns {{capability: object, stats: object, fingerprint: string}}
 */
export function createFakeSearchCapability(options = {}) {
  const apiKey = options.apiKey || "fake-adapter-key";
  const providerId = options.provider || "fake";
  const fingerprint = crypto.createHash("sha256").update(apiKey).digest("hex");
  const scripted = options.search || {};
  const stats = { validate: 0, cacheIdentity: 0, invoke: 0, lastRequest: null };
  const capability = {
    validate(request) {
      stats.validate += 1;
      if (typeof request.query !== "string" || request.query.trim().length === 0) {
        throw new ValidationError("fake search query must contain non-whitespace text");
      }
    },
    cacheIdentity(request) {
      stats.cacheIdentity += 1;
      stats.lastRequest = request;
      return {
        provider: providerId,
        capability: "search",
        credentialFingerprint: fingerprint,
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      stats.invoke += 1;
      stats.lastRequest = request;
      if (typeof scripted.error === "function") {
        const error = scripted.error(stats.invoke);
        if (error !== null && error !== undefined) throw error;
      } else if (scripted.error instanceof Error) {
        throw scripted.error;
      }
      if (typeof scripted.result === "function") {
        return scripted.result(request, stats.invoke);
      }
      if (scripted.result !== undefined) {
        return scripted.result;
      }
      throw new Error("fake search invoke called without a scripted result/error");
    },
  };
  return { capability, stats, fingerprint };
}

/**
 * Fake Search Provider Descriptor. Always advertises `search`; the
 * created Adapter exposes `adapter.search` — the capability itself
 * (shared execution calls `validate` / `cacheIdentity` / `invoke`
 * directly on it, unlike the nested `{ fetch }` / `{ run }` slots).
 *
 * @returns {{descriptor: object, stats: object}}
 */
export function createFakeSearchDescriptor({
  id = "fake",
  apiKey = "fake-adapter-key",
  configured = true,
  capabilityOptions = {},
  extraCapabilities = [],
  omitSearchOnAdapter = false,
} = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = makeCapabilityDescriptor({
    id,
    configured,
    capabilityId: "search",
    extraCapabilities,
    omitOnAdapter: omitSearchOnAdapter,
    slot: "search",
    makeCapability: () => createFakeSearchCapability({ apiKey, provider: id, ...capabilityOptions }).capability,
    stats,
  });
  return { descriptor, stats };
}
