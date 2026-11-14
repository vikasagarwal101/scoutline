import { createSelectedNativeJudge, type TypesafeJudgeDeps, type TypesafeJudgeProfile } from "./lean-typesafe-judge.js";
import type { JudgeDescriptor } from "./judge-config.js";

export function createOpenRouterJudge(deps: TypesafeJudgeDeps, model?: string): TypesafeJudgeProfile & { readonly descriptor: JudgeDescriptor } {
  return createSelectedNativeJudge("openrouter", deps, model);
}
