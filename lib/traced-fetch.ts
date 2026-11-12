// A fetch that records each outgoing HTTP call as a span in Langfuse, nested under whatever is running (a turbopuffer
// call or a model call). It's passed to the turbopuffer and Anthropic clients, so a trace shows network time next to
// each service's own timings. Outside a trace, or without Langfuse keys, it's plain fetch.
//
// Recorded: method, host, path, status, time until the response headers arrived, and request and response sizes.
// Never recorded: bodies, query strings or headers (they can hold keys and query vectors).
import "server-only";
import { startObservation } from "@langfuse/tracing";
import { langfuseEnabled } from "./langfuse-setup";
import { insideTrace } from "./langfuse";

export const tracedFetch: typeof fetch = async (input, init) => {
  if (!langfuseEnabled || !insideTrace()) return fetch(input, init);
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return fetch(input, init);
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const requestBytes = typeof init?.body === "string" ? init.body.length : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let span: any;
  try {
    span = startObservation(`http ${method} ${url.host}`, {
      input: { method, host: url.host, path: url.pathname },
      metadata: { kind: "http", method, host: url.host, path: url.pathname, requestBytes },
    }, { asType: "span" });
  } catch {
    return fetch(input, init); // tracing must never break the request
  }
  const t0 = performance.now();
  try {
    const res = await fetch(input, init);
    const ms = Math.round(performance.now() - t0);
    const len = Number(res.headers.get("content-length"));
    safe(() => span.update({
      output: { status: res.status, ms },
      // For a streamed response (the copilot's model calls) this is time to first byte; the stream continues after.
      metadata: { status: res.status, ms, responseBytes: Number.isFinite(len) && len > 0 ? len : undefined,
        streamed: (res.headers.get("content-type") ?? "").includes("event-stream") },
      ...(res.ok ? {} : { level: res.status >= 500 ? "ERROR" : "WARNING", statusMessage: `HTTP ${res.status}` }),
    }).end());
    return res;
  } catch (e) {
    safe(() => span.update({ level: "ERROR", statusMessage: String((e as Error)?.message ?? e).slice(0, 300) }).end());
    throw e;
  }
};

function safe(f: () => unknown) {
  try {
    f();
  } catch {
    // ignore tracing errors
  }
}
