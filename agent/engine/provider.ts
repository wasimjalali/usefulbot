import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessageEventStream, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { catalogFor } from "../../shared/live-models.ts";
import { exactModelOption, modelSeesImages } from "../../shared/models.ts";
import { UNKNOWN_WINDOW_TOKENS } from "../../shared/policy.ts";
import type { ModelSelection } from "../../shared/session-selection.ts";
import { routerFetch } from "../lib/router-fetch.ts";
import { routerIds } from "../lib/router-identity.ts";

/**
 * The model path through the router (SPEC 5.3). One native Pi provider,
 * `useful-router`, serves every selection: a model per (connection, model)
 * the owner has actually used, registered lazily. A stream delegates to Pi's
 * own `openai-completions` implementation with `routerFetch` as its fetch, so
 * every attempt carries the chat's router ids and the turn's frozen selection,
 * and the router resolves the selection only for the alias `workhorse`.
 */

export const PROVIDER_ID = "useful-router";
/** The alias the router resolves the `x-useful-selection` header for. */
const ROUTER_ALIAS = "workhorse";
const FALLBACK_OUTPUT_CAP = 32_768;

/** What a model call needs to know about the turn it belongs to. */
export type TurnBinding = {
  chatId: string;
  turnId: string;
  selection: ModelSelection;
};

/**
 * The turn a model call belongs to. Pi's own summary calls (compaction) get a
 * session id of their own, so the binding rides the async context of the turn
 * that triggered them, which makes the summary share the chat's router session
 * and the turn's frozen selection (SPEC 5.3).
 */
export const turnBindings = new AsyncLocalStorage<TurnBinding>();

export function modelKey(selection: Pick<ModelSelection, "connectionId" | "modelId">): string {
  return `${selection.connectionId}/${selection.modelId}`;
}

/** Pi's key for a per-model compaction override: `${provider}/${model.id}`. */
export function overrideKey(selection: Pick<ModelSelection, "connectionId" | "modelId">): string {
  return `${PROVIDER_ID}/${modelKey(selection)}`;
}

let registryOutputCap: number | null = null;

/** The router's own output cap for the alias, read from the registry it enforces. */
function aliasOutputCap(): number {
  if (registryOutputCap !== null) return registryOutputCap;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/registry.json", import.meta.url)), "utf8")) as {
      entries?: { alias?: string; maxOutputTokens?: number }[];
    };
    const cap = raw.entries?.find((entry) => entry.alias === ROUTER_ALIAS)?.maxOutputTokens;
    registryOutputCap = Number.isInteger(cap) && (cap as number) > 0 ? (cap as number) : FALLBACK_OUTPUT_CAP;
  } catch {
    registryOutputCap = FALLBACK_OUTPUT_CAP;
  }
  return registryOutputCap;
}

export type ModelFacts = { windowTokens: number; maxTokens: number; vision: boolean | null };

/** Window, output cap and vision of one selection, from the catalog the router reads too. */
export function factsFor(selection: Pick<ModelSelection, "connectionId" | "modelId">): ModelFacts {
  const option = exactModelOption(selection.modelId, catalogFor(selection.connectionId));
  const tokens = option?.contextTokens;
  const windowTokens = Number.isInteger(tokens) && (tokens as number) > 0 ? (tokens as number) : UNKNOWN_WINDOW_TOKENS;
  return {
    windowTokens,
    // The router's rule (outputCapFor): the alias cap, and a tenth of the window.
    maxTokens: Math.max(1, Math.min(aliasOutputCap(), Math.floor(windowTokens / 10))),
    vision: modelSeesImages(option),
  };
}

export type ProviderOptions = {
  /** `http://127.0.0.1:<routerPort>/v1`, never `localhost` (the router refuses it). */
  baseUrl: string;
  /** The desktop token, read on every call. */
  token: () => string;
  /** Test seam: the fetch underneath routerFetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal | null | undefined) => Promise<void>;
  /** Called when a model is registered, so compaction overrides can follow. */
  onModel?: (model: Model<Api>, facts: ModelFacts, selection: ModelSelection) => void;
};

const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  supportsLongCacheRetention: false,
  sendSessionAffinityHeaders: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
} as const;

export class RouterProvider {
  private readonly models = new Map<string, Model<Api>>();

  private readonly options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.options = options;
  }

  /**
   * The Pi model for a selection, registered on first use and again whenever its
   * facts change (a refreshed model list can move the window or drop vision); a
   * new object makes the next turn rebuild its session.
   */
  modelFor(selection: ModelSelection): Model<Api> {
    const key = modelKey(selection);
    const known = this.models.get(key);
    const facts = factsFor(selection);
    if (known && known.contextWindow === facts.windowTokens && known.maxTokens === facts.maxTokens
      && known.input.includes("image") === (facts.vision !== false)) return known;
    const model: Model<"openai-completions"> = {
      id: key,
      name: selection.modelId,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: this.options.baseUrl,
      reasoning: false,
      input: facts.vision === false ? ["text"] : ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: facts.windowTokens,
      maxTokens: facts.maxTokens,
      compat: { ...COMPAT },
    };
    this.models.set(key, model);
    this.options.onModel?.(model, facts, selection);
    return model;
  }

  private stream(model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream {
    const binding = turnBindings.getStore();
    if (!binding) throw new Error("model_call_without_turn");
    const fetchWith = routerFetch({
      ids: () => routerIds(binding.chatId, binding.turnId),
      selection: () => binding.selection,
      authorization: () => `Bearer ${this.options.token()}`,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
    const upstreamPayload = streamOptions?.onPayload;
    return streamOpenAICompletions(model as Model<"openai-completions">, context, {
      ...streamOptions,
      fetch: fetchWith as typeof fetch,
      // routerFetch waits out 429s itself and stamps a fresh request id on every attempt.
      maxRetries: 0,
      onPayload: async (payload, payloadModel) => {
        const next = upstreamPayload ? await upstreamPayload(payload, payloadModel) : undefined;
        return { ...((next ?? payload) as Record<string, unknown>), model: ROUTER_ALIAS };
      },
    });
  }

  /** The Pi `Provider` to register with the model runtime. */
  provider(): Provider {
    return {
      id: PROVIDER_ID,
      name: "Useful router",
      baseUrl: this.options.baseUrl,
      auth: {
        apiKey: {
          name: "Useful router",
          resolve: async () => ({ auth: { apiKey: this.options.token() } }),
        },
      },
      getModels: () => [...this.models.values()],
      stream: ((model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => this.stream(model, context, streamOptions)) as Provider["stream"],
      streamSimple: (model, context, streamOptions) => this.stream(model, context, streamOptions),
    } as Provider;
  }
}
