/**
 * JSON 值类型 —— Definition 与所有持久化字段的地基。
 *
 * 铁律：Workflow Definition 必须 JSON serializable。
 * 凡是需要落库的东西都用这里的类型表达，不要用 function / class / Date / Map。
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * 运行时校验：判断一个未知值是否是纯 JSON（不含 undefined / function / Date / 环）。
 *
 * 用祖先集合做环检测：自引用的对象在这里会被判为「不是 JSON」，
 * 而不是把递归栈打爆（那会让调用方收到 RangeError，而不是一个可处理的失败）。
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return walk(value, new Set<object>());
}

function walk(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;
  if (ancestors.has(object)) return false;

  ancestors.add(object);
  try {
    if (Array.isArray(object)) return object.every((item) => walk(item, ancestors));

    const proto: unknown = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(object).every((item) => walk(item, ancestors));
  } finally {
    ancestors.delete(object);
  }
}
