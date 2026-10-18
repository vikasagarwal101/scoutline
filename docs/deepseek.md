# DeepSeek provider

DeepSeek supplies Search, Reader, and Diagnostics through its standalone
[Search & Fetch APIs](https://api-docs.deepseek.com/guides/search/).

```bash
export DEEPSEEK_API_KEY="your-deepseek-key"
scoutline search "TypeScript release notes" --provider deepseek --count 5
scoutline read https://example.com/article --provider deepseek
scoutline doctor --provider deepseek --probe
```

Create a key at https://platform.deepseek.com/api_keys, or store it through
`scoutline init`. Environment credentials override file credentials. Keys
must never appear in command arguments. To prefer DeepSeek automatically:

```bash
scoutline config set routing.search deepseek
scoutline config set routing.reader deepseek
```

## Search

Requests use `POST https://api.deepseek.com/v1/tools/search` with bearer
authentication. Search returns provider-neutral titles, URLs, summaries,
site names, and publication dates; an empty result list is valid.

- `--count` forwards the requested count, capped at 50 (wire default 10).
  `--count 0` uses Scoutline's existing no-request path.
- `--domain` prefixes a `site:` operator. `--topic news` and `finance`
  use Scoutline's shared keyword appendage.
- `--recency` appends `after:YYYY-MM-DD` using a UTC date: one day,
  seven days, 30 days, or 365 days before today. Filtering therefore has
  day precision. `noLimit` adds no operator.
- The final query, including controls, must contain 1–128 Unicode code
  points. Longer queries fail validation without truncation or API access.
- `--location`, `--content-size`, and `--type video` are rejected with
  `UNSUPPORTED_OPTION`. DeepSeek localization accepts an IP address;
  Scoutline's country selector has no faithful mapping.

Cache keys include the effective query, count, and credential fingerprint.
The date cutoff is bound at cache lookup and reused through retries;
the next lookup refreshes it. Search requests use `need_content: false`;
retrieve complete page content through `read`.

## Reader

`read` uses `POST https://api.deepseek.com/v1/tools/fetch`. It returns a
schema-version-1 reader envelope with Markdown content. Fetch reports no
resolved URL, so `finalUrl` preserves the requested URL; it is not evidence
of a redirect destination. Blank titles normalize to `null`.

URLs must use HTTP or HTTPS, have a host, contain no embedded credentials,
and contain at most 8192 Unicode code points. Reader supports Markdown
and `--timeout` (seconds). Text format, image stripping, link/image
summaries, GFM toggles, image-data-URL retention, and explicit JavaScript
rendering controls are rejected before API access.

## Timeouts, errors, and cost

`DEEPSEEK_TIMEOUT` sets the per-request budget in milliseconds (default
30000). Invalid or non-positive values use the default; excessive values
are clamped to Node's timer maximum. Reader `--timeout` overrides it.
The budget covers headers and body consumption. Bodies are read
incrementally under Scoutline's 50 MiB in-memory ceiling. Cancellation
stops local work; it does not prove that remote work or billing stopped.

HTTP 401 becomes `AUTH_ERROR`; 402 becomes terminal `QUOTA_ERROR`;
408/504 become `TIMEOUT_ERROR`; other HTTP failures retain their status
as `API_ERROR`. In particular, Fetch's 403 security-policy response is
not classified as an invalid credential. Shared execution owns retries
and provider fallback; the adapter makes one attempt per invocation.

`doctor --probe` makes one search request with count 1 and can incur a
charge. No quota capability is advertised; quota availability remains
unknown. The usage ledger counts attempts, rather than invoiced requests.
DeepSeek documents billing for successful nonempty searches and successful
content fetches; consult its current [billing rules](https://api-docs.deepseek.com/guides/search/#billing).
