import type { EffortId } from "./models.ts";

export type AuthMode = "oauth" | "plan" | "api" | "local";
export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type KeyHeader = "bearer" | "x-api-key" | "api-key";

export interface UnlistedModel {
  id: string;
  label: string;
}

/**
 * GPT-6 models a ChatGPT plan runs through Sign in with ChatGPT although
 * GET /v1/models doesn't list them (UB-016). OpenAI's docs call that list "a
 * catalog, not an entitlement check; a successfully completed inference turn
 * verifies access":
 * https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * Live turns on a Plus plan completed on all three, see
 * evals/results/2026-10-06-chatgpt-model-catalog.md. A listed row for the same
 * id wins. The first refusal for an account drops the model from that
 * account's menu (router/src/upstreams/opencode.ts).
 */
export const CHATGPT_UNLISTED_MODELS: UnlistedModel[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
  { id: "gpt-6-sol", label: "GPT-6-Sol" },
  { id: "gpt-6-luna", label: "GPT-6-Luna" },
];

export interface ProviderMode {
  mode: AuthMode;
  /** Name shown in the Connect list for this (provider, mode) pair, e.g. "ChatGPT" for openai/oauth, "OpenAI" for openai/api. */
  label: string;
  /** Subtitle shown on a connected row: "Subscription" (oauth and plan), "API", "Local". */
  kindLabel: "Subscription" | "API" | "Local";
  baseUrl: string;
  protocol: Protocol;
  keyHeader: KeyHeader;
  /** GET {baseUrl}/models works with this credential. */
  listsModels: boolean;
  /** Query string the /models call needs. The ChatGPT Codex list requires client_version. */
  modelsQuery?: Record<string, string>;
  keyUrl: string | null;
  hint: string;
  /** Extra text fields the connect sheet must collect (Cloudflare account id, custom base URL). */
  fields?: Array<{ id: string; label: string; placeholder: string; secret?: boolean }>;
  /** openai: Sign in with ChatGPT (browser authorization code flow) instead of a device flow. */
  signIn?: "chatgpt";
  /**
   * Models the plan runs that the vendor's /models list leaves out. They are
   * merged into the live list and checked on first use (shared/live-models.ts,
   * router/src/upstreams/opencode.ts).
   */
  unlistedModels?: UnlistedModel[];
  /** Default model per alias when nothing is selected yet. */
  defaults: { workhorse: string; reviewer: string };
  /**
   * POST {baseUrl}/images/generations works with this credential, OpenAI
   * shaped, and these are the model ids it takes. The vendor /models list
   * does not name them, so the image picker reads this static list.
   * `path` overrides the endpoint (OpenRouter serves POST /images), and
   * `listPath` is the vendor's own list of the models that endpoint serves,
   * fetched next to /models (OpenRouter's /models hides image-only models).
   */
  images?: { models: string[]; path?: string; listPath?: string };
  /** models.dev provider key used for context window / modality facts (shared/live-models.ts). null when models.dev has no entry. */
  modelsDevId: string | null;
  /** Extra static headers on inference calls (OpenRouter attribution). */
  headers?: Record<string, string>;
  /** opencode-go only: send x-opencode-session. */
  opencodeSession?: boolean;
  /**
   * The vendor doesn't allow Useful Bot on this route (UB-015). The mode stays
   * in the catalogue so a connection stored before the retirement is still
   * recognised, shown with this message and removable, but it is never offered
   * for connecting, never listed in a picker and never called. `message` is
   * what the owner reads in Providers and in a refused turn.
   */
  retired?: { message: string };
}

export interface ProviderDef {
  id: string;
  /** Vendor name for grouping: "OpenAI". */
  name: string;
  /** SVG mark slug: brand/providers/<icon>.svg. Missing file falls back to the monogram. */
  icon: string;
  /** Monogram for the icon until real marks ship: 1 or 2 characters. */
  monogram: string;
  modes: ProviderMode[];
  /** How this vendor takes reasoning effort on the wire. `levels` are this app's EffortId values the vendor accepts; the adapter maps the rest to the nearest lower level. */
  reasoning: { param: "reasoning_effort" | "reasoning.effort" | "thinking" | "none"; levels: EffortId[] };
}

const MODES: AuthMode[] = ["oauth", "plan", "api", "local"];

export const PROVIDER_CATALOG: ProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    monogram: "O",
    modes: [
      {
        mode: "oauth",
        label: "ChatGPT",
        kindLabel: "Subscription",
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-responses",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: null,
        hint: "ChatGPT Plus or Pro through Sign in with ChatGPT.",
        // Official Sign in with ChatGPT for open-source apps (browser sign-in
        // with PKCE on a loopback callback, no device code), documented at
        // https://developers.openai.com/siwc/token-sharing-open-source/sign-in
        // and .../models-and-inference. The flow lives in
        // shared/chatgpt-signin.ts; inference is the public Responses API.
        signIn: "chatgpt",
        unlistedModels: CHATGPT_UNLISTED_MODELS,
        // Checked against the live ChatGPT model list on 2026-09-19 (GPT-5.6
        // Sol, Terra and Luna, GPT-6 Astra, GPT-5.5). Only the fallback until
        // the live list lands; the live list overrides these.
        defaults: { workhorse: "gpt-5.6-luna", reviewer: "gpt-6-astra" },
        modelsDevId: "openai",
      },
      {
        mode: "api",
        label: "OpenAI",
        kindLabel: "API",
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://platform.openai.com/api-keys",
        hint: "API key from platform.openai.com.",
        defaults: { workhorse: "gpt-4.1-mini", reviewer: "gpt-4.1" },
        // The ChatGPT subscription (oauth mode) has no images endpoint; the
        // API key does. gpt-image-1 answers b64_json only.
        images: { models: ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"] },
        modelsDevId: "openai",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    id: "github-copilot",
    icon: "github-copilot",
    name: "GitHub",
    monogram: "GH",
    modes: [
      {
        mode: "oauth",
        label: "GitHub Copilot",
        kindLabel: "Subscription",
        baseUrl: "https://api.githubcopilot.com",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: null,
        hint: "",
        // Removed 2026-10-06: the copilot_internal sign-in is undocumented, and
        // GitHub's only formal third-party route is the Copilot SDK.
        retired: {
          message: "GitHub doesn't support this Copilot sign-in in Useful Bot, so it's been turned off. Pick another provider.",
        },
        defaults: { workhorse: "gpt-5.4-mini", reviewer: "gpt-5.4" },
        modelsDevId: "github-copilot",
      },
    ],
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "opencode-go",
    icon: "opencode-go",
    name: "OpenCode",
    monogram: "Go",
    modes: [
      {
        mode: "plan",
        label: "OpenCode Go",
        kindLabel: "Subscription",
        baseUrl: "https://opencode.ai/zen/go/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://opencode.ai/auth",
        hint: "Plan key from opencode.ai/auth.",
        defaults: { workhorse: "glm-5.3-flash", reviewer: "glm-5.3" },
        modelsDevId: "opencode-go",
        opencodeSession: true,
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "high", "max"] },
  },
  {
    id: "zai",
    icon: "zai",
    name: "Z.ai",
    monogram: "Z",
    modes: [
      {
        mode: "plan",
        label: "GLM Coding Plan",
        kindLabel: "Subscription",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://z.ai/manage-apikey/apikey-list",
        hint: "GLM Coding Plan key from the Z.ai console.",
        retired: {
          message: "Z.ai only allows the GLM Coding Plan in its supported coding tools, so Useful Bot can't use it. Connect a Z.ai API key instead, then disconnect this one.",
        },
        // UNVERIFIED: exact plan model ids are not confirmed against the
        // models.dev zai-coding-plan entry here. The live list overrides these.
        defaults: { workhorse: "glm-5.3-flash", reviewer: "glm-5.3" },
        modelsDevId: "zai-coding-plan",
      },
      {
        mode: "api",
        label: "Z.ai",
        kindLabel: "API",
        baseUrl: "https://api.z.ai/api/paas/v4",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://z.ai/manage-apikey/apikey-list",
        hint: "API key from the Z.ai console.",
        // UNVERIFIED: not checked against the models.dev zai entry here.
        defaults: { workhorse: "glm-4.5-air", reviewer: "glm-4.5" },
        // Z.AI image generation per docs.z.ai/api-reference/image/generate-image.
        // glm-image answers a URL the router downloads; cogview-4-250304 does too.
        images: { models: ["glm-image", "cogview-4-250304"] },
        modelsDevId: "zai",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "high", "max"] },
  },
  {
    id: "moonshot",
    icon: "moonshot",
    name: "Moonshot",
    monogram: "K",
    modes: [
      {
        mode: "plan",
        label: "Kimi Code",
        kindLabel: "Subscription",
        baseUrl: "https://api.kimi.com/coding/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://www.kimi.com/code/console",
        hint: "Kimi Code key from kimi.com/code/console.",
        // UNVERIFIED: exact plan model ids are not confirmed against the
        // models.dev kimi-code-plan-global entry here.
        defaults: { workhorse: "kimi-for-coding-highspeed", reviewer: "kimi-for-coding" },
        modelsDevId: "kimi-code-plan-global",
      },
      {
        mode: "api",
        label: "Moonshot AI",
        kindLabel: "API",
        baseUrl: "https://api.moonshot.ai/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://platform.kimi.ai",
        hint: "API key from platform.moonshot.ai.",
        // UNVERIFIED: not checked against the models.dev moonshotai entry here.
        defaults: { workhorse: "kimi-k2.6", reviewer: "kimi-k3" },
        modelsDevId: "moonshotai",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "high", "max"] },
  },
  {
    id: "alibaba",
    icon: "alibaba",
    name: "Alibaba",
    monogram: "Q",
    modes: [
      {
        mode: "plan",
        label: "Qwen Coding Plan",
        kindLabel: "Subscription",
        // International endpoint. CN users have a separate host
        // (https://coding.dashscope.aliyuncs.com/v1) with non portable keys,
        // but plan keys stay on the host that issued them, so one field is enough.
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
        hint: "Coding Plan key from Alibaba ModelStudio.",
        retired: {
          message: "Alibaba only allows the Qwen Coding Plan in interactive coding tools, so Useful Bot can't use it. Connect a Qwen (DashScope) API key instead, then disconnect this one.",
        },
        // UNVERIFIED: exact plan model ids are not confirmed against the
        // models.dev alibaba-coding-plan entry here.
        defaults: { workhorse: "qwen3.6-flash", reviewer: "qwen3.7-max" },
        modelsDevId: "alibaba-coding-plan",
      },
      {
        mode: "api",
        label: "Qwen (DashScope)",
        kindLabel: "API",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
        hint: "API key from Alibaba ModelStudio.",
        // UNVERIFIED: not checked against the models.dev alibaba entry here.
        defaults: { workhorse: "qwen-plus", reviewer: "qwen-max" },
        modelsDevId: "alibaba",
      },
    ],
    // UNVERIFIED: Qwen thinking modes vary by model family. The ladder below is
    // a guess the live list and adapter can narrow later.
    reasoning: { param: "reasoning_effort", levels: ["low", "medium", "high"] },
  },
  {
    id: "minimax",
    icon: "minimax",
    name: "MiniMax",
    monogram: "MM",
    modes: [
      {
        mode: "plan",
        label: "MiniMax Token Plan",
        kindLabel: "Subscription",
        baseUrl: "https://api.minimax.io/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://platform.minimax.io/subscribe/token-plan",
        hint: "Token Plan key from the MiniMax console.",
        // UNVERIFIED: exact plan model ids are not confirmed against the
        // models.dev minimax-coding-plan entry here.
        defaults: { workhorse: "MiniMax-M2.7-highspeed", reviewer: "MiniMax-M3" },
        modelsDevId: "minimax-coding-plan",
      },
      {
        mode: "api",
        label: "MiniMax",
        kindLabel: "API",
        baseUrl: "https://api.minimax.io/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://platform.minimax.io",
        hint: "API key from the MiniMax console.",
        // UNVERIFIED: not checked against the models.dev minimax entry here.
        defaults: { workhorse: "MiniMax-M2.7-highspeed", reviewer: "MiniMax-M3" },
        modelsDevId: "minimax",
      },
    ],
    // UNVERIFIED: MiniMax documents thinking blocks only on its Anthropic path.
    // Nothing is sent on the OpenAI path until the adapter says otherwise.
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "xiaomi",
    icon: "xiaomi",
    name: "Xiaomi",
    monogram: "Mi",
    modes: [
      {
        mode: "plan",
        label: "MiMo Token Plan",
        kindLabel: "Subscription",
        // Global host. Regional hosts (token-plan-cn, token-plan-ams) exist with
        // non portable keys, so CN or EU users need the matching host and key.
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        protocol: "openai-chat",
        keyHeader: "api-key",
        listsModels: true,
        keyUrl: "https://mimo.mi.com",
        hint: "Token Plan key from the MiMo console.",
        // UNVERIFIED: exact plan model ids are not confirmed against the
        // models.dev xiaomi-token-plan-sgp entry here.
        defaults: { workhorse: "mimo-v2.5", reviewer: "mimo-v2.5-pro" },
        modelsDevId: "xiaomi-token-plan-sgp",
      },
      {
        mode: "api",
        label: "Xiaomi MiMo",
        kindLabel: "API",
        baseUrl: "https://api.xiaomimimo.com/v1",
        protocol: "openai-chat",
        keyHeader: "api-key",
        listsModels: true,
        keyUrl: "https://mimo.mi.com",
        hint: "API key from the MiMo console.",
        // UNVERIFIED: not checked against the models.dev xiaomi entry here.
        defaults: { workhorse: "mimo-v2-flash", reviewer: "mimo-v2-pro" },
        modelsDevId: "xiaomi",
      },
    ],
    // UNVERIFIED: MiMo documents a thinking toggle only, with no effort ladder.
    // Nothing is sent until the adapter says otherwise.
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "command-code",
    icon: "command-code",
    name: "Command Code",
    monogram: "CC",
    modes: [
      {
        mode: "plan",
        label: "Command Code",
        kindLabel: "Subscription",
        // Documented at https://commandcode.ai/docs/provider: chat at
        // /provider/v1/chat/completions and the live list at /provider/v1/models,
        // Bearer key. "Every plan except the Go plan has API access."
        baseUrl: "https://api.commandcode.ai/provider/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://commandcode.ai/settings/keys",
        hint: "Command Code key (every plan except Go).",
        // UNVERIFIED: no models.dev entry exists, and plan model ids are unknown.
        defaults: { workhorse: "deepseek-v3", reviewer: "deepseek-r1" },
        modelsDevId: null,
      },
    ],
    // UNVERIFIED: no reasoning catalogue is published. Nothing is sent.
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "anthropic",
    icon: "anthropic",
    name: "Anthropic",
    monogram: "A",
    modes: [
      {
        mode: "api",
        label: "Anthropic",
        kindLabel: "API",
        baseUrl: "https://api.anthropic.com/v1",
        protocol: "anthropic-messages",
        keyHeader: "x-api-key",
        listsModels: true,
        // GET /v1/models 400s without the version header (the messages
        // adapter sends the same value) and pages at 20 rows by default.
        headers: { "anthropic-version": "2023-06-01" },
        modelsQuery: { limit: "1000" },
        keyUrl: "https://platform.claude.com/settings/keys",
        hint: "API key from console.anthropic.com.",
        // UNVERIFIED: not checked against the models.dev anthropic entry here.
        defaults: { workhorse: "claude-sonnet-4-5", reviewer: "claude-opus-4-8" },
        modelsDevId: "anthropic",
      },
    ],
    reasoning: { param: "thinking", levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    id: "google",
    icon: "google",
    name: "Google",
    monogram: "G",
    modes: [
      {
        mode: "api",
        label: "Google",
        kindLabel: "API",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://aistudio.google.com/apikey",
        hint: "Gemini API key from AI Studio.",
        defaults: { workhorse: "gemini-2.5-flash", reviewer: "gemini-2.5-pro" },
        modelsDevId: "google",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "medium", "high"] },
  },
  {
    id: "xai",
    icon: "xai",
    name: "xAI",
    monogram: "X",
    modes: [
      {
        mode: "api",
        label: "xAI Grok",
        kindLabel: "API",
        baseUrl: "https://api.x.ai/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://console.x.ai",
        hint: "API key from console.x.ai.",
        // UNVERIFIED: not checked against the models.dev xai entry here.
        defaults: { workhorse: "grok-4.6", reviewer: "grok-4.5" },
        // Grok Imagine per docs.x.ai/developers/model-capabilities/images/generation.
        images: { models: ["grok-imagine-image", "grok-imagine-image-quality"] },
        modelsDevId: "xai",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "medium", "high", "xhigh"] },
  },
  {
    id: "deepseek",
    icon: "deepseek",
    name: "DeepSeek",
    monogram: "DS",
    modes: [
      {
        mode: "api",
        label: "DeepSeek",
        kindLabel: "API",
        // No version segment. DeepSeek serves /chat/completions and /models
        // straight off the host.
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://platform.deepseek.com/api_keys",
        hint: "API key from platform.deepseek.com.",
        defaults: { workhorse: "deepseek-v4-flash", reviewer: "deepseek-v4-pro" },
        modelsDevId: "deepseek",
      },
    ],
    reasoning: { param: "reasoning_effort", levels: ["low", "high", "max"] },
  },
  {
    id: "openrouter",
    icon: "openrouter",
    name: "OpenRouter",
    monogram: "OR",
    modes: [
      {
        mode: "api",
        label: "OpenRouter",
        kindLabel: "API",
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://openrouter.ai/keys",
        hint: "One key for many models, including Claude.",
        defaults: { workhorse: "openai/gpt-4.1-mini", reviewer: "anthropic/claude-sonnet-4" },
        modelsDevId: "openrouter",
        // OpenRouter image generation per openrouter.ai/docs/features/multimodal/image-generation:
        // POST /images answers b64_json, and GET /images/models lists what it
        // serves with each model's formats and aspect ratios. That list fills
        // the picker; the static id is the pick when nothing is chosen yet.
        images: {
          models: ["google/gemini-3.1-flash-image"],
          path: "images",
          listPath: "images/models",
        },
        headers: {
          "HTTP-Referer": "https://bot.usefulbuild.com",
          "X-Title": "Useful Bot",
        },
      },
    ],
    reasoning: { param: "reasoning.effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    id: "vercel",
    icon: "vercel",
    name: "Vercel",
    monogram: "V",
    modes: [
      {
        mode: "api",
        label: "Vercel AI Gateway",
        kindLabel: "API",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://vercel.com/dashboard",
        hint: "API key from the Vercel dashboard.",
        // UNVERIFIED: gateway slugs are provider/model pairs. These follow the
        // OpenRouter convention and may need correcting from the live list.
        defaults: { workhorse: "openai/gpt-4.1-mini", reviewer: "anthropic/claude-sonnet-4" },
        modelsDevId: "vercel",
      },
    ],
    // UNVERIFIED: the gateway passes reasoning through per upstream model.
    reasoning: { param: "reasoning.effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    id: "cloudflare",
    icon: "cloudflare",
    name: "Cloudflare",
    monogram: "CF",
    modes: [
      {
        mode: "api",
        label: "Cloudflare Workers AI",
        kindLabel: "API",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: false,
        keyUrl: "https://dash.cloudflare.com",
        hint: "Account ID plus an API token.",
        fields: [{ id: "accountId", label: "Account ID", placeholder: "Cloudflare account ID" }],
        // No digest confirms a DeepSeek style default, so both aliases use the
        // contract fallback. The live list is off (listsModels false).
        defaults: {
          workhorse: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          reviewer: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        },
        modelsDevId: null,
      },
    ],
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "opencode",
    icon: "opencode",
    name: "OpenCode",
    monogram: "Z",
    modes: [
      {
        mode: "api",
        label: "OpenCode Zen",
        kindLabel: "API",
        baseUrl: "https://opencode.ai/zen/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://opencode.ai/auth",
        hint: "API key from opencode.ai/auth.",
        // UNVERIFIED: Zen model id shape is not confirmed. The live list
        // overrides these on first refresh.
        defaults: { workhorse: "glm-5.3-flash", reviewer: "glm-5.3" },
        modelsDevId: "opencode",
      },
    ],
    // UNVERIFIED: Zen reasoning is per model family. This passes effort through
    // until the adapter maps per model.
    reasoning: { param: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    id: "ollama",
    icon: "ollama",
    name: "Ollama",
    monogram: "Ol",
    modes: [
      {
        mode: "api",
        label: "Ollama Cloud",
        kindLabel: "API",
        baseUrl: "https://ollama.com/v1",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: "https://ollama.com/settings/keys",
        hint: "API key from ollama.com/settings/keys.",
        // UNVERIFIED: local style ids below. The live list overrides these.
        defaults: { workhorse: "gpt-oss:20b", reviewer: "gpt-oss:120b" },
        modelsDevId: "ollama-cloud",
      },
      {
        mode: "local",
        label: "Ollama",
        kindLabel: "Local",
        baseUrl: "{baseUrl}",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: null,
        hint: "Local server, no key needed.",
        fields: [{ id: "baseUrl", label: "Server URL", placeholder: "http://localhost:11434/v1" }],
        // UNVERIFIED: local ids depend on what is pulled. The live list
        // overrides these when the server runs.
        defaults: { workhorse: "qwen3", reviewer: "llama3.3" },
        modelsDevId: null,
      },
    ],
    // UNVERIFIED: Ollama documents a native think flag, not an effort ladder.
    // Nothing is sent until the adapter says otherwise.
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "lmstudio",
    icon: "lmstudio",
    name: "LM Studio",
    monogram: "LM",
    modes: [
      {
        mode: "local",
        label: "LM Studio",
        kindLabel: "Local",
        baseUrl: "{baseUrl}",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: null,
        hint: "Local server, no key needed.",
        fields: [{ id: "baseUrl", label: "Server URL", placeholder: "http://localhost:1234/v1" }],
        // UNVERIFIED: local ids depend on what is loaded. The live list
        // overrides these when the server runs.
        defaults: { workhorse: "openai/gpt-oss-20b", reviewer: "qwen/qwen3-coder-30b" },
        modelsDevId: "lmstudio",
      },
    ],
    reasoning: { param: "none", levels: [] },
  },
  {
    id: "custom",
    icon: "custom",
    name: "Custom",
    monogram: "+",
    modes: [
      {
        mode: "local",
        label: "Custom provider",
        kindLabel: "API",
        // Substituted from the baseUrl field below, so the sheet collects it.
        baseUrl: "{baseUrl}",
        protocol: "openai-chat",
        keyHeader: "bearer",
        listsModels: true,
        keyUrl: null,
        hint: "Any OpenAI compatible server.",
        fields: [
          { id: "name", label: "Name", placeholder: "My provider" },
          { id: "baseUrl", label: "Server URL", placeholder: "https://example.com/v1" },
          { id: "key", label: "API key", placeholder: "Optional", secret: true },
        ],
        // UNVERIFIED: placeholders until the live list returns real ids.
        defaults: { workhorse: "custom-1", reviewer: "custom-1" },
        modelsDevId: null,
      },
    ],
    reasoning: { param: "none", levels: [] },
  },
];

export function providerDef(id: string): ProviderDef {
  const def = PROVIDER_CATALOG.find((entry) => entry.id === id);
  if (!def) throw new Error("provider_unknown");
  return def;
}

export function providerMode(id: string, mode: AuthMode): ProviderMode {
  const def = providerDef(id);
  const row = def.modes.find((entry) => entry.mode === mode);
  if (!row) throw new Error("provider_mode_unknown");
  return row;
}

/** The owner-facing message of a retired route, or null when the connection id names a live (or unknown) route. */
export function retiredRouteMessage(id: string): string | null {
  const sep = id.lastIndexOf(":");
  if (sep <= 0) return null;
  const def = PROVIDER_CATALOG.find((entry) => entry.id === id.slice(0, sep));
  return def?.modes.find((entry) => entry.mode === id.slice(sep + 1))?.retired?.message ?? null;
}

export function connectionId(providerId: string, mode: AuthMode): string {
  providerDef(providerId);
  if (!MODES.includes(mode)) throw new Error("provider_mode_unknown");
  return `${providerId}:${mode}`;
}

export function parseConnectionId(id: string): { providerId: string; mode: AuthMode } {
  const sep = id.lastIndexOf(":");
  if (sep <= 0 || sep === id.length - 1) throw new Error("connection_unknown");
  const providerId = id.slice(0, sep);
  const mode = id.slice(sep + 1) as AuthMode;
  if (!MODES.includes(mode)) throw new Error("connection_unknown");
  providerDef(providerId);
  providerMode(providerId, mode);
  return { providerId, mode };
}
