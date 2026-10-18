import { MAX_BUFFERED_RESPONSE_BYTES, readBoundedResponseBody } from "../../lib/bounded-body.js";
import { ApiError, AuthError, NetworkError, QuotaError, ScoutlineError, TimeoutError, ValidationError } from "../../lib/errors.js";
import { parseRetryAfterHintMs, retryHintOptions } from "../../lib/retry-after.js";
import { clampTimeoutMs } from "../../lib/timeout.js";

export interface DeepSeekTransportDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** Direct JSON API. One abort budget covers headers and the bounded body;
 * no adapter-local retries, raw error bodies, or credential-bearing redirects.
 */
export async function requestDeepSeek(
  endpoint: "search" | "fetch",
  apiKey: string,
  body: Readonly<Record<string, unknown>>,
  deps: DeepSeekTransportDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const timeoutMs = clampTimeoutMs(Number(deps.env?.DEEPSEEK_TIMEOUT ?? 30000), 30000);
  const cancelled = () => new TimeoutError(0, "DeepSeek request cancelled");
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  signal?.addEventListener("abort", onCancel, { once: true });
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  let timedOut = false;
  const timeoutError = () => timedOut
    ? new TimeoutError(timeoutMs, "Increase DEEPSEEK_TIMEOUT or retry later") : cancelled();
  const onAbort = () => rejectAbort(timeoutError());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = (deps.setTimeout ?? setTimeout)(() => { timedOut = true; controller.abort(); }, timeoutMs);

  const run = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(`https://api.deepseek.com/v1/tools/${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new NetworkError("DeepSeek network error");
    }
    // A non-cooperative fetch may settle after the caller has timed out.
    if (controller.signal.aborted) {
      await response.body?.cancel().catch(() => {});
      throw timeoutError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const retry = retryHintOptions(parseRetryAfterHintMs(response.headers));
      if (response.status === 401) throw new AuthError("DeepSeek authentication failed", "DEEPSEEK_API_KEY");
      if (response.status === 402) throw new QuotaError("DeepSeek account balance is insufficient", "Top up your DeepSeek account before retrying");
      if (response.status === 408 || response.status === 504) throw new TimeoutError(timeoutMs, "Increase DEEPSEEK_TIMEOUT or retry later", retry);
      throw new ApiError("DeepSeek request failed", response.status, retry);
    }
    if (Number(response.headers.get("Content-Length")) > MAX_BUFFERED_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      // A local fixed ceiling cannot improve on retry. Do not attach a
      // synthetic upstream 5xx status, which shared execution would retry.
      throw new ScoutlineError("DeepSeek response exceeds the in-memory limit", "API_ERROR");
    }
    // pipeThrough propagates cancellation even when an injected body stream
    // does not observe the fetch signal itself. Never use text()/json() here.
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: controller.signal }) ?? null;
    let bytes: Buffer;
    try {
      bytes = await readBoundedResponseBody(stream, MAX_BUFFERED_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ValidationError) throw new ScoutlineError("DeepSeek response exceeds the in-memory limit", "API_ERROR");
      throw new NetworkError("DeepSeek network error");
    }
    if (controller.signal.aborted) throw timeoutError();
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new ApiError("DeepSeek returned malformed JSON", 502); }
  };
  try {
    const result = await Promise.race([run(), aborted]);
    if (controller.signal.aborted) throw timeoutError();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError();
    if (error instanceof ScoutlineError) throw error;
    throw new NetworkError("DeepSeek network error");
  } finally {
    (deps.clearTimeout ?? clearTimeout)(timer);
    signal?.removeEventListener("abort", onCancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
