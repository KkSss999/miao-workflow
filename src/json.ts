/**
 * JSON 值类型 —— Definition 与所有持久化字段的地基。
 *
 * 铁律：Workflow Definition 必须 JSON serializable。
 * 凡是需要落库的东西都用这里的类型表达，不要用 function / class / Date / Map。
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** 运行时校验：判断一个未知值是否是纯 JSON（不含 undefined / function / Date 等）。 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value).every(isJsonValue);
    }
    default:
      return false;
  }
}
