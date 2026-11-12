// Langfuse tracing helpers: every search and copilot question becomes one trace, with a generation per model call
// (the full prompt, the response, tokens and cost) and an observation per turbopuffer call. See lib/langfuse-setup.ts
// for the exporter.
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { propagateAttributes, startObservation, type PropagateAttributesParams } from "@langfuse/tracing";
import { ensureLangfuse } from "./langfuse-setup";
import { priced, priceOf, type Price } from "./pricing";

export { flushLangfuse } from "./langfuse-setup";

/**
 * Run `fn` as the start of a new trace: detached from any incoming request context, with user, session, tags and
 * metadata applied to every observation created inside it.
 */
export function newTrace<T>(attributes: PropagateAttributesParams, fn: () => T): T {
  ensureLangfuse();
  const tagged = { ...attributes, tags: ["food-finder", ...(attributes.tags ?? [])] };
  return tracing.run(true, () => context.with(ROOT_CONTEXT, () => propagateAttributes(tagged, fn)));
}

// Set inside newTrace, so code below it (the turbopuffer logger) can tell a traced request from a plain page load.
const tracing = new AsyncLocalStorage<true>();

/** True when running inside a trace started by newTrace. */
export const insideTrace = (): boolean => tracing.getStore() === true;

// ---------------------------------------------------------------- Anthropic → chat format
// Langfuse renders OpenAI-style messages as a conversation: tool calls as cards (arguments as a JSON string), tool
// results as tool messages, and thinking as a `thinking` list on the assistant message.

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  thinking?: { type: "thinking"; content: string }[];
};

const textOf = (c: string | { type: string; text?: string }[]) =>
  typeof c === "string" ? c : c.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");

/** One assistant message from a model response or an earlier assistant turn. */
export function assistantMessage(content: string | (Anthropic.ContentBlock | Anthropic.ContentBlockParam)[]): ChatMessage {
  if (typeof content === "string") return { role: "assistant", content };
  const msg: ChatMessage = { role: "assistant", content: "" };
  const text: string[] = [];
  for (const b of content) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "tool_use") {
      (msg.tool_calls ??= []).push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
    } else if (b.type === "thinking") {
      // With thinking display "omitted" the block arrives empty; there's nothing to show.
      if (b.thinking.trim()) (msg.thinking ??= []).push({ type: "thinking", content: b.thinking });
    }
    else if (b.type === "redacted_thinking") (msg.thinking ??= []).push({ type: "thinking", content: "(redacted by the provider)" });
  }
  msg.content = text.join("\n");
  return msg;
}

/** The full prompt of an Anthropic Messages call as chat messages, system prompt first. */
export function chatMessages(system: string | undefined, messages: Anthropic.MessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push(assistantMessage(m.content));
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content ? textOf(b.content as string | { type: string; text?: string }[]) : "" });
      } else if (b.type === "text") text.push(b.text);
    }
    if (text.length) out.push({ role: "user", content: text.join("\n") });
  }
  return out;
}

/** Tool definitions in the Chat Completions shape, shown with the prompt. */
export const chatTools = (tools: Anthropic.Tool[]) =>
  tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/** Usage and cost in Langfuse's shape. Cost is omitted when the price is unknown (Langfuse then infers it, if it can). */
export function usageOf(
  usage: Anthropic.Usage,
  price: Price | null,
): { usageDetails: Record<string, number>; costDetails?: Record<string, number> } {
  const usageDetails: Record<string, number> = { input: usage.input_tokens, output: usage.output_tokens };
  if (usage.cache_read_input_tokens) usageDetails.input_cache_read = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens) usageDetails.input_cache_creation = usage.cache_creation_input_tokens;
  if (!price) return { usageDetails };
  const c = priced(price, { input: usage.input_tokens, output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 });
  const costDetails: Record<string, number> = { input: c.input, output: c.output, total: c.total };
  if (c.input_cache_read) costDetails.input_cache_read = c.input_cache_read;
  if (c.input_cache_creation) costDetails.input_cache_creation = c.input_cache_creation;
  return { usageDetails, costDetails };
}

/** The prompt of a Messages call as Langfuse shows it: chat messages, plus tool definitions when there are any. */
export function promptOf(params: { system?: string | unknown; messages: Anthropic.MessageParam[]; tools?: Anthropic.ToolUnion[] }) {
  const messages = chatMessages(typeof params.system === "string" ? params.system : undefined, params.messages);
  const tools = (params.tools ?? []).filter((t): t is Anthropic.Tool => "input_schema" in t);
  return tools.length ? { messages, tools: chatTools(tools) } : { messages };
}

/** A non-streaming Messages call recorded as a generation under the active observation. */
export async function tracedCreate(
  name: string,
  llm: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  metadata?: Record<string, unknown>,
): Promise<Anthropic.Message> {
  const modelParameters: Record<string, string | number> = { max_tokens: params.max_tokens };
  if (params.tool_choice) modelParameters.tool_choice = params.tool_choice.type === "tool" ? params.tool_choice.name : params.tool_choice.type;
  const gen = startObservation(
    name,
    { model: params.model, modelParameters, input: promptOf(params as Parameters<typeof promptOf>[0]), metadata },
    { asType: "generation" },
  );
  try {
    const msg = await llm.messages.create(params);
    gen.update({
      output: assistantMessage(msg.content),
      ...usageOf(msg.usage, await priceOf(params.model)),
      metadata: { ...metadata, stopReason: msg.stop_reason },
    });
    return msg;
  } catch (e) {
    gen.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) });
    throw e;
  } finally {
    gen.end();
  }
}
