// Langfuse exporter setup, kept apart from lib/langfuse.ts so instrumentation.ts can load it without server-only code.
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; LANGFUSE_BASE_URL picks the region
// (https://us.cloud.langfuse.com for US cloud). Every trace is tagged food-finder, so it can share a Langfuse project
// with TrialScope.
//
// The tracer provider is Langfuse's own, not the global OpenTelemetry one, so Next.js's built-in request spans never
// reach Langfuse and nothing else in the app changes. Spans are batched; routes flush them with after(flushLangfuse)
// so a Vercel function doesn't freeze before they're sent.
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

const g = globalThis as typeof globalThis & { __langfuse?: LangfuseSpanProcessor | null };

export const langfuseEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

/** Set up the exporter once per server instance. Called from instrumentation.ts; safe to call again. */
export function ensureLangfuse(): void {
  if (g.__langfuse !== undefined) return;
  if (!langfuseEnabled) {
    g.__langfuse = null;
    return;
  }
  // Without a context manager, OpenTelemetry can't carry the active observation across awaits, and every
  // observation would start its own trace instead of nesting under the question it belongs to.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const processor = new LangfuseSpanProcessor({
    // Keys and LANGFUSE_BASE_URL are read from the environment by the processor itself.
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  });
  setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
  g.__langfuse = processor;
}

/** Send buffered spans. Pass to after() in each traced route. */
export async function flushLangfuse(): Promise<void> {
  try {
    await g.__langfuse?.forceFlush();
  } catch (e) {
    console.log(JSON.stringify({ langfuse: "flush_error", message: (e as Error).message.slice(0, 200) }));
  }
}
