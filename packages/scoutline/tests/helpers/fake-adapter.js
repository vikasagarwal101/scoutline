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
 */
import crypto from "node:crypto";

import {
  decodeRepositoryDirectoryListing,
  decodeRepositoryFile,
  decodeRepositorySearch,
} from "../../dist/capabilities/repository.js";
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
