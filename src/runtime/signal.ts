import type { JsonValue } from "../json.js";
import type { IsoTimestamp } from "./run.js";

/**
 * Signal —— 外部世界叫醒 workflow 的唯一方式。
 *
 * 人类审批、Webhook 回调、别的系统通知，全都长这样：
 *
 * ```ts
 * await client.signal(runId, "approval", { decision: "approve" });
 * ```
 *
 * 关键点：signal 先落库，然后才去 wake run。
 * 所以「信号已到达但进程崩了」不会丢；`consumed_at` 保证同一条只消费一次。
 */
export interface WorkflowSignal {
  id: string;
  runId: string;
  name: string;
  payload: JsonValue | undefined;
  createdAt: IsoTimestamp;
  /** null = 还没被消费 */
  consumedAt: IsoTimestamp | null;
}

export interface SignalInput {
  name: string;
  payload?: JsonValue;
}
