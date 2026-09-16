/**
 * 手搓的 wasm 二进制编码器 —— 只为生成测试夹具，不装任何工具链。
 *
 * 机器上没有 wasm 编译器（clang 没有 wasm backend，rustc 只装了 wasm32-wasip2 组件模型），
 * 所以这里直接把 spec 的二进制格式写出来。生成的模块只做内存搬运，不需要字符串处理能力：
 *
 *   mwf_execute 返回： {"status":"completed","output":{"echo":  <请求 JSON>  }}
 *
 * 一次断言就能同时证明：内存写入、长度前缀、JSON 往返、以及模块确实收到了完整请求。
 *
 * 参考：https://webassembly.github.io/spec/core/binary/
 */

const enum Section {
  Type = 1,
  Import = 2,
  Function = 3,
  Memory = 5,
  Global = 6,
  Export = 7,
  Code = 10,
  Data = 11,
}

const I32 = 0x7f;

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  let more = true;
  while (more) {
    let byte = rest & 0x7f;
    rest >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((rest === 0 && !signBit) || (rest === -1 && signBit)) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
}

function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: Section, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function name(text: string): number[] {
  const bytes = utf8(text);
  return [...uleb(bytes.length), ...bytes];
}

/** 字节数组拼接（可读性优先，夹具不追求性能） */
function concat(...parts: number[][]): number[] {
  return parts.flat();
}

export interface I32Function {
  /** 参数个数（全是 i32） */
  params?: number;
  /** 局部变量个数（全是 i32） */
  locals?: number;
  /** 函数体（不含结尾的 `end`） */
  body: number[];
}

/** 手写指令的小助手（全是 i32 世界） */
export const op = {
  i32Const(value: number): number[] {
    return [0x41, ...sleb(value)];
  },
  localGet(index: number): number[] {
    return [0x20, ...uleb(index)];
  },
  localSet(index: number): number[] {
    return [0x21, ...uleb(index)];
  },
  globalGet(index: number): number[] {
    return [0x23, ...uleb(index)];
  },
  globalSet(index: number): number[] {
    return [0x24, ...uleb(index)];
  },
  i32Add(): number[] {
    return [0x6a];
  },
  /** i32.store align=2 offset=0 */
  i32Store(): number[] {
    return [0x36, 0x02, 0x00];
  },
  /** memory.copy（bulk memory，wasm 2.0；Node 18+ 都支持） */
  memoryCopy(): number[] {
    return [0xfc, 0x0a, 0x00, 0x00];
  },
  call(funcIndex: number): number[] {
    return [0x10, ...uleb(funcIndex)];
  },
  drop(): number[] {
    return [0x1a];
  },
  unreachable(): number[] {
    return [0x00];
  },
  end(): number[] {
    return [0x0b];
  },
};

export interface ModuleSpec {
  /** 导入的函数（模块名 + 字段名），签名都是 () -> () */
  imports?: { module: string; name: string }[];
  /** 定义并导出的函数，名字 → 实现 */
  functions: Record<string, I32Function>;
  /** 数据段：偏移 → 字节 */
  data?: { offset: number; bytes: Uint8Array }[];
  /** 内存页数 */
  pages?: number;
  /** 可变 i32 全局变量（初始值） */
  globals?: number[];
  /** 导出的 memory 名字（默认 "memory"） */
  memoryExport?: string;
}

/**
 * 生成一个符合 mwf ABI v1 的模块。
 *
 * 生成的导出：
 * - `memory`（可选用 memoryExport 改名，用于测试「没有导出 memory」的情况）
 * - `mwf_abi_version` / `mwf_alloc` / `mwf_free` / `mwf_reset` / `mwf_execute`
 */
export function buildModule(spec: ModuleSpec): Uint8Array {
  const imports = spec.imports ?? [];
  const functionNames = Object.keys(spec.functions);
  const globals = spec.globals ?? [];

  // 类型段：三种签名
  //  type 0: () -> i32                  （mwf_abi_version 等）
  //  type 1: (i32) -> i32               （mwf_alloc）
  //  type 2: (i32, i32) -> i32          （mwf_execute）
  //  type 3: () -> ()                   （imports / mwf_free / mwf_reset）
  //  type 4: (i32, i32) -> ()           （mwf_free）
  const types: number[][] = [
    [0x60, ...uleb(0), ...uleb(1), I32],
    [0x60, ...uleb(1), I32, ...uleb(1), I32],
    [0x60, ...uleb(2), I32, I32, ...uleb(1), I32],
    [0x60, ...uleb(0), ...uleb(0)],
    [0x60, ...uleb(2), I32, I32, ...uleb(0)],
  ];
  const sigIndex = (params: number, results: number): number => {
    if (params === 0 && results === 1) return 0;
    if (params === 1 && results === 1) return 1;
    if (params === 2 && results === 1) return 2;
    if (params === 0 && results === 0) return 3;
    return 4;
  };

  const importEntries = imports.map((entry) => concat(name(entry.module), name(entry.name), [0x00], uleb(3)));
  const importedCount = imports.length;

  const definedTypes = functionNames.map((functionName) => {
    const fn = spec.functions[functionName] as I32Function;
    return uleb(sigIndex(fn.params ?? 0, fn.body.length > 0 && returnsValue(functionName) ? 1 : 0));
  });

  const exportEntries: number[][] = [];
  if (spec.memoryExport !== "") {
    // memory 段只有一个内存，索引 0
    exportEntries.push(concat(name(spec.memoryExport ?? "memory"), [0x02], uleb(0)));
  }
  functionNames.forEach((functionName, index) => {
    exportEntries.push(concat(name(functionName), [0x00], uleb(importedCount + index)));
  });

  const bodies = functionNames.map((functionName) => {
    const fn = spec.functions[functionName] as I32Function;
    const localDecls = fn.locals === undefined || fn.locals === 0 ? uleb(0) : concat(uleb(1), uleb(fn.locals), [I32]);
    const body = concat(localDecls, fn.body, op.end());
    return concat(uleb(body.length), body);
  });

  const dataSegments = (spec.data ?? []).map((segment) =>
    concat([0x00], op.i32Const(segment.offset), op.end(), uleb(segment.bytes.length), [...segment.bytes]),
  );

  const bytes = concat(
    [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], // magic + version
    section(Section.Type, vec(types)),
    imports.length > 0 ? section(Section.Import, vec(importEntries)) : [],
    section(Section.Function, vec(definedTypes)),
    section(Section.Memory, vec([[0x00, ...uleb(spec.pages ?? 1)]])),
    globals.length > 0
      ? section(
          Section.Global,
          vec(globals.map((value) => concat([I32, 0x01], op.i32Const(value), op.end()))),
        )
      : [],
    section(Section.Export, vec(exportEntries)),
    section(Section.Code, vec(bodies)),
    dataSegments.length > 0 ? section(Section.Data, vec(dataSegments)) : [],
  );

  return new Uint8Array(bytes);
}

function returnsValue(functionName: string): boolean {
  return functionName !== "mwf_free" && functionName !== "mwf_reset";
}

/* ────────────────────────── 现成的夹具模块 ────────────────────────── */

const HEAP_BASE = 4096;
const DATA_BASE = 1024; // 数据段放在堆下面，避免 bump allocator 踩到自己

const ECHO_PREFIX = `{"status":"completed","output":{"echo":`;
const ECHO_SUFFIX = `}}`;

/**
 * `mwf_execute` 把请求原样嵌进响应：`{"status":"completed","output":{"echo": <请求>}}`
 *
 * 行为只依赖请求内容，所以可以用来验证「模块确实收到了完整请求」。
 */
export function buildEchoModule(): Uint8Array {
  const prefix = new TextEncoder().encode(ECHO_PREFIX);
  const suffix = new TextEncoder().encode(ECHO_SUFFIX);
  const prefixOffset = DATA_BASE;
  const suffixOffset = DATA_BASE + prefix.length;

  return buildModule({
    pages: 1,
    globals: [HEAP_BASE],
    data: [
      { offset: prefixOffset, bytes: prefix },
      { offset: suffixOffset, bytes: suffix },
    ],
    functions: {
      mwf_abi_version: { body: op.i32Const(1) },
      // bump allocator：全局 0 是当前堆顶
      mwf_alloc: {
        params: 1,
        locals: 1,
        body: concat(
          op.globalGet(0),
          op.localSet(1), // local1 = p
          op.globalGet(0),
          op.localGet(0),
          op.i32Add(),
          op.globalSet(0), // sp += size
          op.localGet(1), // return p
        ),
      },
      mwf_free: { params: 2, body: [] },
      mwf_reset: { body: concat(op.i32Const(HEAP_BASE), op.globalSet(0)) },
      mwf_execute: {
        params: 2,
        locals: 2,
        body: concat(
          // local2 = 响应 JSON 的长度（前缀 + 请求 + 后缀）
          op.localGet(1),
          op.i32Const(prefix.length + suffix.length),
          op.i32Add(),
          op.localSet(2),
          // local3 = resp = alloc(4 + local2)
          op.localGet(2),
          op.i32Const(4),
          op.i32Add(),
          op.call(1),
          op.localSet(3),
          // 写长度前缀（u32 LE）
          op.localGet(3),
          op.localGet(2),
          op.i32Store(),
          // 拷前缀：dest = resp + 4, src = prefixOffset, n = prefix.length
          op.localGet(3),
          op.i32Const(4),
          op.i32Add(),
          op.i32Const(prefixOffset),
          op.i32Const(prefix.length),
          op.memoryCopy(),
          // 拷请求：dest = resp + 4 + prefix.length, src = requestPtr, n = requestLen
          op.localGet(3),
          op.i32Const(4 + prefix.length),
          op.i32Add(),
          op.localGet(0),
          op.localGet(1),
          op.memoryCopy(),
          // 拷后缀：dest = resp + 4 + prefix.length + requestLen
          op.localGet(3),
          op.i32Const(4 + prefix.length),
          op.i32Add(),
          op.localGet(1),
          op.i32Add(),
          op.i32Const(suffixOffset),
          op.i32Const(suffix.length),
          op.memoryCopy(),
          // return resp
          op.localGet(3),
        ),
      },
    },
  });
}

/** 固定返回一个 canned 响应（用来测 waiting / failed / 非法响应等分支） */
export function buildCannedModule(response: string, options: { abiVersion?: number } = {}): Uint8Array {
  const bytes = new TextEncoder().encode(response);
  const offset = DATA_BASE;

  return buildModule({
    pages: 1,
    globals: [HEAP_BASE],
    data: [{ offset, bytes }],
    functions: {
      mwf_abi_version: { body: op.i32Const(options.abiVersion ?? 1) },
      mwf_alloc: {
        params: 1,
        locals: 1,
        body: concat(
          op.globalGet(0),
          op.localSet(1),
          op.globalGet(0),
          op.localGet(0),
          op.i32Add(),
          op.globalSet(0),
          op.localGet(1),
        ),
      },
      mwf_free: { params: 2, body: [] },
      mwf_reset: { body: concat(op.i32Const(HEAP_BASE), op.globalSet(0)) },
      mwf_execute: {
        params: 2,
        locals: 1,
        body: concat(
          // local2 = resp = alloc(4 + len)
          op.i32Const(4 + bytes.length),
          op.call(1),
          op.localSet(2),
          op.localGet(2),
          op.i32Const(bytes.length),
          op.i32Store(),
          op.localGet(2),
          op.i32Const(4),
          op.i32Add(),
          op.i32Const(offset),
          op.i32Const(bytes.length),
          op.memoryCopy(),
          op.localGet(2),
        ),
      },
    },
  });
}

/** 执行时直接 trap */
export function buildTrapModule(): Uint8Array {
  return buildModule({
    pages: 1,
    globals: [HEAP_BASE],
    functions: {
      mwf_abi_version: { body: op.i32Const(1) },
      mwf_alloc: { params: 1, body: op.i32Const(HEAP_BASE) },
      mwf_free: { params: 2, body: [] },
      mwf_execute: { params: 2, body: op.unreachable() },
    },
  });
}

/** 声称响应有 4GB（用来验证宿主的 bounds 检查） */
export function buildHugeLengthModule(): Uint8Array {
  return buildModule({
    pages: 1,
    globals: [HEAP_BASE],
    functions: {
      mwf_abi_version: { body: op.i32Const(1) },
      mwf_alloc: { params: 1, body: op.i32Const(HEAP_BASE) },
      mwf_free: { params: 2, body: [] },
      mwf_execute: {
        params: 2,
        locals: 1,
        body: concat(
          op.i32Const(HEAP_BASE),
          op.localSet(2),
          // 写一个离谱的长度：0xFFFFFFF0
          op.localGet(2),
          op.i32Const(-16),
          op.i32Store(),
          op.localGet(2),
        ),
      },
    },
  });
}

/** 依赖一个 import（用来验证「宿主默认什么都不给」与显式白名单两条路） */
export function buildImportingModule(): Uint8Array {
  const response = new TextEncoder().encode(`{"status":"completed","output":{"imported":true}}`);

  return buildModule({
    pages: 1,
    globals: [HEAP_BASE],
    imports: [{ module: "env", name: "mwf_probe" }],
    data: [{ offset: DATA_BASE, bytes: response }],
    functions: {
      mwf_abi_version: { body: op.i32Const(1) },
      mwf_alloc: {
        params: 1,
        locals: 1,
        body: concat(
          op.globalGet(0),
          op.localSet(1),
          op.globalGet(0),
          op.localGet(0),
          op.i32Add(),
          op.globalSet(0),
          op.localGet(1),
        ),
      },
      mwf_free: { params: 2, body: [] },
      mwf_execute: {
        params: 2,
        locals: 1,
        body: concat(
          // 调一次宿主给的 env.mwf_probe()，证明能力是宿主中介的
          op.call(0),
          op.i32Const(4 + response.length),
          op.call(2), // 1 个 import 占掉索引 0 → mwf_alloc 是 2
          op.localSet(2),
          op.localGet(2),
          op.i32Const(response.length),
          op.i32Store(),
          op.localGet(2),
          op.i32Const(4),
          op.i32Add(),
          op.i32Const(DATA_BASE),
          op.i32Const(response.length),
          op.memoryCopy(),
          op.localGet(2),
        ),
      },
    },
  });
}

export const FIXTURES = {
  prefixBytes: new TextEncoder().encode(ECHO_PREFIX),
  suffixBytes: new TextEncoder().encode(ECHO_SUFFIX),
};
