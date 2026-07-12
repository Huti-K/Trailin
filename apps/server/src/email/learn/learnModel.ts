import type { Api, Model } from "@earendil-works/pi-ai";
import { getActiveModelIds, modelRegistry, resolveActiveModel } from "../../llm/registry.js";

/**
 * Cheap-tier model resolution shared by the two LLM seams in this package
 * (matchLLM.ts's tiebreak, extractLLM.ts's nightly extraction) — same
 * approach as email/enrich/enrichLLM.ts's resolveEnrichModel: both calls fire
 * often enough (matching runs on every debounced "mail" event; extraction
 * runs per account per night) that cost discipline beats eloquence, so a
 * cheaper same-provider tier is tried first, falling back to whatever model
 * is actually configured.
 */

const CHEAP_MODEL_CANDIDATES = ["claude-haiku-4-5", "claude-haiku-4-5-20251001"];

export async function resolveLearnModel(): Promise<Model<Api>> {
  const { provider } = await getActiveModelIds();
  for (const id of CHEAP_MODEL_CANDIDATES) {
    const model = modelRegistry.getModel(provider, id);
    if (model) return model;
  }
  return resolveActiveModel();
}
