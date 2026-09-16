import type { JsonObject, JsonValue } from "../json.js";
import type { StepDefinition, StepId } from "../definition/step.js";
import { NoMatchingTransitionError } from "./errors.js";
import type { GuardResolver } from "./registry.js";

export interface ResolveNextStepArgs {
  runId: string;
  stepId: StepId;
  step: StepDefinition;
  /** 本步 patch 之后的最新 context */
  context: JsonObject;
  output: JsonValue | undefined;
  guards: GuardResolver;
}

/**
 * 决定下一步。
 *
 * 顺序即优先级，第一个命中的赢：
 *   1. 遍历 `next`
 *   2. `when` 省略 = 兜底分支（validation 保证它一定在最后）
 *   3. `when` 命中 guard 且返回 true
 *   4. 全都没命中 → 抛 NoMatchingTransitionError（这是定义错误，不是运行错误）
 *
 * @returns 下一步 step id；`null` 表示这是终点步骤，run 应当 COMPLETED。
 *
 * 纯函数：没有 IO、没有时间、没有随机 —— 同样的 (step, context, output) 永远得到同样的结果。
 * 不做 deterministic replay 是我们和 Temporal 的分野，但「转移可预测」这一条不能丢。
 */
export function resolveNextStep(args: ResolveNextStepArgs): StepId | null {
  const { runId, stepId, step, context, output, guards } = args;
  if (step.next.length === 0) return null;

  for (const transition of step.next) {
    if (transition.when === undefined) return transition.to;

    const guard = guards.resolveGuard(transition.when);
    const matched = guard({ runId, stepId, context, output });
    if (matched) return transition.to;
  }

  throw new NoMatchingTransitionError(
    stepId,
    step.next.map((transition) => transition.when ?? "(fallback)"),
  );
}
