import type { StepId } from "../definition/step.js";
import type { JsonObject } from "../json.js";
import type { IsoTimestamp } from "./run.js";

/**
 * Audit event —— 只追加、不修改。
 *
 * 这是「这个 run 到底发生了什么」的唯一权威来源。
 * UI 的 timeline、排障、合规全都读它，不要读 step_runs 拼。
 */
export type WorkflowEventType =
  | "workflow.created"
  | "workflow.started"
  | "workflow.waiting"
  | "workflow.retrying"
  | "workflow.resumed"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.cancelled"
  | "step.started"
  | "step.completed"
  | "step.waiting"
  | "step.retrying"
  | "step.failed"
  | "step.unknown"
  | "signal.received";

export interface WorkflowEvent {
  id: string;
  runId: string;
  stepId: StepId | null;
  type: WorkflowEventType;
  payload: JsonObject;
  createdAt: IsoTimestamp;
}
