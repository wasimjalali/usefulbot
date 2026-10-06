import { parseConnectionId, providerDef, providerMode } from "./provider-catalog.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const SPEEDS = ["standard", "fast"] as const;

export type EffortId = (typeof EFFORTS)[number];
export type SpeedId = (typeof SPEEDS)[number];

export type ModelOption = {
  id: string;
  label: string;
  efforts: EffortId[];
  defaultEffort: EffortId | null;
  speeds: SpeedId[];
  defaultSpeed: SpeedId;
  /** Context window in tokens from the models.dev catalog; absent when unknown. */
  contextTokens?: number;
  /** Input modalities from the catalog ("text", "image", ...); absent when unknown. */
  inputs?: string[];
  /** Output modalities from the catalog ("text", "image", ...); absent when unknown. */
  outputs?: string[];
  /** Listed by the vendor's image endpoint (OpenRouter /images/models): an image generator for certain. */
  imageGen?: boolean;
  /** Aspect ratios the image endpoint takes for this model ("16:9", ...); absent when unknown. */
  aspectRatios?: string[];
};

/** Catalog facts about one model that the live list cannot tell on its own. */
export type ModelMeta = {
  contextTokens?: number;
  inputs?: string[];
  outputs?: string[];
  imageGen?: boolean;
  aspectRatios?: string[];
  /** Set only when the vendor's own list names them (the ChatGPT Codex list does); they beat the guess by name. */
  label?: string;
  efforts?: EffortId[];
  defaultEffort?: EffortId | null;
};

/**
 * Whether the model takes image input. Null when the catalog has not said:
 * a caller that gates on it lets the upstream decide rather than refusing
 * on missing data.
 */
export function modelSeesImages(model: Pick<ModelOption, "inputs"> | null | undefined): boolean | null {
  if (!model?.inputs) return null;
  return model.inputs.includes("image");
}

/**
 * Whether the model answers with images. Null when the catalog has not said;
 * image-only rows still get a "yes" from the static provider lists, which set
 * outputs themselves.
 */
export function modelMakesImages(model: Pick<ModelOption, "outputs"> | null | undefined): boolean | null {
  if (!model?.outputs) return null;
  return model.outputs.includes("image");
}

/**
 * Whether the model answers with text. Null when the catalog has not said.
 * A model the catalog names image-only (outputs without "text") is not a
 * chat pick: it would fail every turn, so the pickers leave it out.
 */
export function modelChats(model: Pick<ModelOption, "outputs"> | null | undefined): boolean | null {
  if (!model?.outputs) return null;
  return model.outputs.includes("text");
}

/**
 * Whether the model is an image generator rather than a chat model: the
 * vendor's image endpoint lists it, or it answers with images and either
 * never with text or its id names it as an image model (gemini-*-image,
 * gpt-5-image). Chat models that also list image output (gpt-5.1,
 * openrouter/auto) stay chat models. The composer leaves these out; the
 * image picker offers only these.
 */
export function modelIsImageGenerator(model: Pick<ModelOption, "id" | "outputs" | "imageGen"> | null | undefined): boolean {
  if (model?.imageGen) return true;
  if (!model || modelMakesImages(model) !== true) return false;
  return modelChats(model) === false || /image|imagine/i.test(model.id);
}

export type ComposerGroup = {
  connectionId: string;
  label: string;
  icon: string;
  models: Array<{ id: string; label: string }>;
};

export type ComposerPublic = {
  providerId: string;
  /** Connection the composer reads, e.g. "openai:api". Empty for legacy bare provider calls. */
  connectionId: string;
  providerName: string;
  modelId: string;
  modelLabel: string;
  effort: EffortId | null;
  effortLabel: string | null;
  speed: SpeedId;
  efforts: Array<{ id: EffortId; label: string }>;
  speeds: Array<{ id: SpeedId; label: string }>;
  models: Array<{ id: string; label: string }>;
  /** One entry per connected connection, the active one first. The macOS model flyout groups by this. */
  groups: ComposerGroup[];
  /**
   * False when this composer cannot carry a turn: no connection, or (per bot)
   * the bot's stored connection is gone or disconnected, or its model left a
   * live list. The stored model is still shown as it is, never swapped.
   */
  available: boolean;
};

const EFFORT_LABELS: Record<EffortId, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const SPEED_LABELS: Record<SpeedId, string> = {
  standard: "Standard",
  fast: "Fast",
};

const OPTIONS: Record<string, ModelOption[]> = {
  "opencode-go:plan": [
    {
      id: "glm-5.3-flash",
      label: "GLM 5.3 Flash",
      efforts: ["low", "high", "max"],
      defaultEffort: "low",
      speeds: ["standard"],
      defaultSpeed: "standard",
    },
    {
      id: "glm-5.3",
      label: "GLM 5.3",
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      speeds: ["standard"],
      defaultSpeed: "standard",
    },
  ],
  "openai:api": [
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 Mini",
      efforts: [],
      defaultEffort: null,
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    },
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      efforts: [],
      defaultEffort: null,
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    },
  ],
  "openrouter:api": [
    {
      id: "openai/gpt-4.1-mini",
      label: "GPT-4.1 Mini",
      efforts: [],
      defaultEffort: null,
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    },
    {
      id: "anthropic/claude-sonnet-4",
      label: "Claude Sonnet 4",
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    },
  ],
  "google:api": [
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      efforts: ["low", "high"],
      defaultEffort: "low",
      speeds: ["standard"],
      defaultSpeed: "standard",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      speeds: ["standard"],
      defaultSpeed: "standard",
    },
  ],
  "anthropic:api": [
    {
      id: "claude-sonnet-4-0",
      label: "Claude Sonnet 4",
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      speeds: ["standard"],
      defaultSpeed: "standard",
    },
  ],
};

export function isEffortId(value: unknown): value is EffortId {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

export function isSpeedId(value: unknown): value is SpeedId {
  return typeof value === "string" && (SPEEDS as readonly string[]).includes(value);
}

export function effortLabel(id: EffortId): string {
  return EFFORT_LABELS[id];
}

export function speedLabel(id: SpeedId): string {
  return SPEED_LABELS[id];
}

export function modelsFor(id: string): ModelOption[] {
  const direct = OPTIONS[id];
  if (direct) return direct;
  const legacy = LEGACY_CONNECTION[id];
  if (legacy) return OPTIONS[legacy] ?? [];
  try {
    const parsed = parseConnectionId(id);
    const mode = providerMode(parsed.providerId, parsed.mode);
    const ids = [...new Set([mode.defaults.workhorse, mode.defaults.reviewer])];
    return ids.map((modelId) => ({
      id: modelId,
      label: humanizeModelId(modelId),
      ...inferCapabilities(modelId, parsed.providerId),
    }));
  } catch {
    return [];
  }
}

/** Bare provider ids from before connections existed, mapped to their api connection. */
const LEGACY_CONNECTION: Record<string, string> = {
  "opencode-go": "opencode-go:plan",
  openai: "openai:api",
  openrouter: "openrouter:api",
  google: "google:api",
  anthropic: "anthropic:api",
};

export function humanizeModelId(id: string): string {
  const slug = id.split("/").pop() ?? id;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "glm") return "GLM";
      if (lower === "gpt") return "GPT";
      if (lower === "kimi") return "Kimi";
      if (lower === "qwen3.8" || lower === "qwen3.7" || lower === "qwen3.6" || lower === "qwen3.5") {
        return `Qwen${part.slice(4)}`;
      }
      if (lower.startsWith("qwen")) return `Qwen${part.slice(4)}`;
      if (lower === "grok") return "Grok";
      if (lower === "mimo") return "MiMo";
      if (lower === "minimax") return "MiniMax";
      if (lower === "deepseek") return "DeepSeek";
      if (lower === "muse") return "Muse";
      if (lower === "hy3" || lower === "hy4") return part.toUpperCase();
      if (lower === "longcat") return "LongCat";
      if (lower === "omen") return "Omen";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function providerPart(id?: string): string | undefined {
  if (!id) return undefined;
  const sep = id.lastIndexOf(":");
  return sep > 0 ? id.slice(0, sep) : id;
}

function speedCaps(id?: string): Pick<ModelOption, "speeds" | "defaultSpeed"> {
  const providerId = providerPart(id);
  // The ChatGPT plan route refuses a service-tier override (OpenAI's
  // preview limits), so the router never sends one there: no Fast toggle.
  if (id === "openai:oauth") return { speeds: ["standard"], defaultSpeed: "standard" };
  if (providerId === "openai" || providerId === "openrouter") {
    return { speeds: ["standard", "fast"], defaultSpeed: "standard" };
  }
  return { speeds: ["standard"], defaultSpeed: "standard" };
}

export function inferCapabilities(
  id: string,
  providerId?: string,
): Pick<ModelOption, "efforts" | "defaultEffort" | "speeds" | "defaultSpeed"> {
  const slug = id.toLowerCase();
  const standard = speedCaps(providerId);
  if (slug.includes("glm")) {
    return { ...standard, efforts: ["low", "high", "max"], defaultEffort: slug.includes("flash") ? "low" : "high" };
  }
  if (slug.includes("kimi") || slug.includes("deepseek") || slug.includes("mimo")) {
    return { ...standard, efforts: ["low", "high", "max"], defaultEffort: slug.includes("flash") ? "low" : "high" };
  }
  if (slug.includes("grok") || slug.includes("luna") || slug.includes("muse")) {
    return { ...standard, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" };
  }
  if (slug.includes("hy4")) {
    return { ...standard, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" };
  }
  if (slug.includes("hy3")) {
    return { ...standard, efforts: ["low", "high"], defaultEffort: "low" };
  }
  if (slug.includes("qwen") || slug.includes("minimax") || slug.includes("longcat")) {
    return { ...standard, efforts: ["high", "max"], defaultEffort: "high" };
  }
  if (slug.includes("gemini")) {
    return { ...standard, efforts: ["low", "high"], defaultEffort: slug.includes("flash") ? "low" : "high" };
  }
  if (slug.includes("claude") || slug.includes("sonnet") || slug.includes("opus")) {
    return { ...standard, efforts: ["low", "high", "max"], defaultEffort: "high" };
  }
  return { ...standard, efforts: [], defaultEffort: null };
}

export function hydrateModel(providerId: string, id: string, label?: string, meta?: ModelMeta): ModelOption {
  const known = modelsFor(providerId).find((item) => item.id === id);
  const base = known
    ? { ...known, label: label?.trim() || known.label }
    : { id, label: label?.trim() || humanizeModelId(id), ...inferCapabilities(id, providerId) };
  if (meta?.contextTokens) base.contextTokens = meta.contextTokens;
  if (meta?.inputs) base.inputs = meta.inputs;
  if (meta?.outputs) base.outputs = meta.outputs;
  if (meta?.imageGen) base.imageGen = true;
  if (meta?.aspectRatios) base.aspectRatios = meta.aspectRatios;
  if (meta?.label) base.label = meta.label;
  if (meta?.efforts) {
    base.efforts = meta.efforts;
    base.defaultEffort = meta.defaultEffort ?? null;
  }
  return base;
}

export function mergeLiveModels(
  providerId: string,
  ids: string[],
  meta: Record<string, ModelMeta> = {},
): ModelOption[] {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const models = unique.map((id) => hydrateModel(providerId, id, undefined, meta[id]));
  const preferred = modelsFor(providerId)[0]?.id;
  return models.sort((a, b) => {
    if (a.id === preferred) return -1;
    if (b.id === preferred) return 1;
    return a.label.localeCompare(b.label);
  });
}

export function modelOption(
  providerId: string,
  modelId: string | null | undefined,
  catalog?: ModelOption[],
): ModelOption | null {
  const list = catalog && catalog.length > 0 ? catalog : modelsFor(providerId);
  return list.find((item) => item.id === modelId) ?? list[0] ?? null;
}

/**
 * The model exactly as the catalog lists it, with no stand-in. `modelOption`
 * falls back to the list's first model, which is right for the legacy global
 * composer and wrong anywhere a pick must be honoured or refused: a per-bot
 * selection, the compaction window, the router's output cap.
 */
export function exactModelOption(
  modelId: string | null | undefined,
  catalog: ModelOption[],
): ModelOption | null {
  return catalog.find((item) => item.id === modelId) ?? null;
}

export function snapComposer(
  id: string,
  providerName: string,
  preferredModel: string | null | undefined,
  preferredEffort: EffortId | null | undefined,
  preferredSpeed: SpeedId | null | undefined,
  catalog?: ModelOption[],
  groups: ComposerGroup[] = [],
  /**
   * Per-bot path: a model missing from the list is shown as stored (with the
   * capabilities its id implies) instead of being replaced by the first one.
   * Whether it may still carry a turn is the caller's call (`available`).
   */
  exact = false,
): ComposerPublic {
  let providerId = id;
  let connectionId = "";
  try {
    providerId = parseConnectionId(id).providerId;
    connectionId = id;
  } catch {
    connectionId = LEGACY_CONNECTION[id] ?? "";
  }
  // Image generators live in the same live list but never carry a chat turn,
  // so neither the pick nor its fallback may land on one.
  const list = (catalog && catalog.length > 0 ? catalog : modelsFor(id))
    .filter((item) => modelChats(item) !== false && !modelIsImageGenerator(item));
  const model = exact
    ? (preferredModel ? (exactModelOption(preferredModel, list) ?? hydrateModel(id, preferredModel)) : null)
    : modelOption(id, preferredModel, list);
  if (!model) {
    return {
      providerId,
      connectionId,
      providerName,
      modelId: "",
      modelLabel: providerName,
      effort: null,
      effortLabel: null,
      speed: "standard",
      efforts: [],
      speeds: [],
      models: [],
      groups,
      available: false,
    };
  }
  const effort = model.efforts.length === 0
    ? null
    : (preferredEffort && model.efforts.includes(preferredEffort) ? preferredEffort : model.defaultEffort);
  // A list cached before the ChatGPT plan route dropped Fast can still name
  // it; that route never sends a service tier, so it is filtered here too.
  const speeds = connectionId === "openai:oauth" ? model.speeds.filter((item) => item !== "fast") : model.speeds;
  const speed = preferredSpeed && speeds.includes(preferredSpeed) ? preferredSpeed : model.defaultSpeed;
  return {
    providerId,
    connectionId,
    providerName,
    modelId: model.id,
    modelLabel: model.label,
    effort,
    effortLabel: effort ? effortLabel(effort) : null,
    speed,
    efforts: model.efforts.map((item) => ({ id: item, label: effortLabel(item) })),
    speeds: speeds.map((item) => ({ id: item, label: speedLabel(item) })),
    models: list.map((item) => ({ id: item.id, label: item.label })),
    groups,
    available: true,
  };
}

const EFFORT_ORDER: EffortId[] = ["low", "medium", "high", "xhigh", "max"];

/** Nearest accepted level at or below the ask. Falls to the lowest level when nothing is lower. */
function nearestLevel(effort: EffortId, levels: EffortId[]): EffortId | null {
  if (levels.length === 0) return null;
  if (levels.includes(effort)) return effort;
  const rank = (id: EffortId) => EFFORT_ORDER.indexOf(id);
  const lower = levels
    .filter((level) => rank(level) <= rank(effort))
    .sort((a, b) => rank(b) - rank(a));
  if (lower[0]) return lower[0];
  return [...levels].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// UNVERIFIED: Anthropic budget tiers are provisional. The router adapter maps
// effort to output_config.effort or thinking.budget_tokens per the digest.
const THINKING_BUDGET: Record<EffortId, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

export function applyReasoning(
  providerId: string,
  effort: EffortId | null,
  speed: SpeedId,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...body };
  const bare = providerPart(providerId) ?? providerId;
  const def = providerDef(bare);
  if (effort) {
    const mapped = nearestLevel(effort, def.reasoning.levels);
    if (mapped) {
      if (def.reasoning.param === "reasoning_effort") {
        next.reasoning_effort = mapped;
      } else if (def.reasoning.param === "reasoning.effort") {
        const prev = next.reasoning;
        next.reasoning = {
          ...(prev && typeof prev === "object" ? (prev as Record<string, unknown>) : {}),
          effort: mapped,
        };
      } else if (def.reasoning.param === "thinking") {
        next.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET[mapped] };
      }
    }
  }
  if (speed === "fast" && (bare === "openai" || bare === "openrouter")) {
    next.service_tier = "priority";
  }
  return next;
}
