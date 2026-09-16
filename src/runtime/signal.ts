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

  /**
   * 入队序号（由 storage 分配，单调递增）。
   *
   * 为什么不能用时间戳判断「这条信号是在等待开始之前还是之后到的」：
   * 墙钟会有同毫秒碰撞，而且发送信号的进程和写等待的进程**时钟可能不一致**。
   * 序列号是唯一可信的先后顺序。
   */
  seq: number;

  /**
   * 定向到某个 step；null = 未定向。
   *
   * 为什么需要它：信号如果只按名字匹配，那么「给 gate1 的第二次批准」会被**后面的 gate2 冒领**
   * ——没有任何人批准过 gate2，它却过了。加了 stepId 之后可以精确投递；
   * 不加也能用，但要走下面的时间窗规则。
   */
  stepId: string | null;

  payload: JsonValue | undefined;
  createdAt: IsoTimestamp;
  /** null = 还没被消费 */
  consumedAt: IsoTimestamp | null;
}

/** 送信号时的可选参数 */
export interface SignalOptions {
  /**
   * 定向到某个 step（可选）。
   *
   * 不填也能用 —— 但那就要遵守「只有等待登记之后入队的信号才可用」的水位线规则，
   * 否则会出现「给 gate1 的第二次批准被 gate2 冒领」。
   */
  stepId?: string;
}

/**
 * 一条信号对某次等待是否**可用**：
 *
 * - 名字必须一致
 * - 定向的（`stepId` 非空）：只要 step 对上就行 —— 发送者明确说了给谁，
 *   哪怕它到得比等待早（比如审批人抢在系统登记等待之前点了）
 * - 未定向的：必须**在这次等待登记之后入队**（`seq > waitSinceSeq`）
 *
 * 未定向 + 早于等待的信号会被**留在队列里**，而不是被猜着消费掉 ——
 * 「丢一个待处理的信号」比「错误批准」可恢复得多，而且它是可见的（countPending / listByRun）。
 */
export function isSignalEligible(
  signal: Pick<WorkflowSignal, "name" | "stepId" | "seq">,
  wait: { name: string; stepId: string; sinceSeq: number },
): boolean {
  if (signal.name !== wait.name) return false;
  if (signal.stepId !== null) return signal.stepId === wait.stepId;
  return signal.seq > wait.sinceSeq;
}
