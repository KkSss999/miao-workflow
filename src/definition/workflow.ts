import type { StepDefinition, StepDefinitionInput, StepId } from "./step.js";
import { normalizeDefinition } from "./validation.js";

export interface WorkflowMeta {
  title?: string;
  description?: string;
  tags?: string[];
}

/** 作者手写的 workflow */
export interface WorkflowDefinitionInput {
  id: string;
  /** 从 1 开始。已发布版本不可修改，改动 = 新版本。 */
  version: number;
  start: StepId;
  steps: Record<StepId, StepDefinitionInput>;
  meta?: WorkflowMeta;
}

/** 归一化之后的 workflow：纯 JSON，可落库、可 hash、可 diff。 */
export interface WorkflowDefinition {
  id: string;
  version: number;
  start: StepId;
  steps: Record<StepId, StepDefinition>;
  meta?: WorkflowMeta;
}

/**
 * 定义 workflow。归一化（简写 → 规范形态）并立刻校验，非法直接抛 ValidationError。
 *
 * 代码里就是这么用：
 *
 * ```ts
 * const workflow = defineWorkflow({
 *   id: "intake-to-action",
 *   version: 1,
 *   start: "triage",
 *   steps: {
 *     triage: { uses: "ai.triage", next: "approval" },
 *     approval: { uses: "human.approval", next: "create-lead" },
 *     "create-lead": { uses: "lead.create", next: "send-email" },
 *     "send-email": { uses: "email.send" }, // 没有 next = 终点
 *   },
 * });
 * ```
 */
export function defineWorkflow(input: WorkflowDefinitionInput): WorkflowDefinition {
  return normalizeDefinition(input);
}
