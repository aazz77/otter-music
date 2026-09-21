/**
 * 老内核 WebView（如 Android TV 系统 WebView 66）缺失 API 的补丁。
 *
 * 白屏根因：构建 target 是 es2018（语法已被 esbuild 降级），但依赖运行时
 * 调用了 Chromium 69~98 才实现的 API，模块执行时抛 TypeError 导致 React
 * 无法挂载。全部补丁带存在性判断，新内核上是 no-op。
 *
 * 覆盖（Chromium 支持版本）：
 * - globalThis            (71)
 * - queueMicrotask        (71)
 * - Array.prototype.flat / flatMap (69)
 * - String.prototype.matchAll      (73)
 * - Array.prototype.at             (92)
 * - crypto.randomUUID              (92)
 * - Object.hasOwn                  (93)
 * - structuredClone                (98)
 */

// --- globalThis (71) -------------------------------------------------------
const gt = (function () {
  if (typeof globalThis !== "undefined") return globalThis;
  if (typeof self !== "undefined") return self;
  if (typeof window !== "undefined") return window;
   
  return new Function("return this")() as typeof globalThis;
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (gt as any).globalThis === "undefined") {
  try {
    Object.defineProperty(gt, "globalThis", {
      value: gt,
      writable: true,
      configurable: true,
    });
  } catch {
    /* 某些封闭环境不允许定义，忽略 */
  }
}

// --- queueMicrotask (71) ---------------------------------------------------
if (typeof gt.queueMicrotask !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gt as any).queueMicrotask = function (cb: () => void) {
    Promise.resolve().then(cb);
  };
}

// --- Array.prototype.flat / flatMap (69) -----------------------------------
if (!Array.prototype.flat) {
   
  Object.defineProperty(Array.prototype, "flat", {
    configurable: true,
    writable: true,
    value: function flat(this: unknown[], depth?: number): unknown[] {
      const d = depth === undefined ? 1 : Math.floor(depth) || 0;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const source = this;
      const out: unknown[] = [];
      const flatten = (arr: unknown[], level: number) => {
        for (const item of arr) {
          if (level > 0 && Array.isArray(item)) flatten(item, level - 1);
          else out.push(item);
        }
      };
      flatten(source, d);
      return out;
    },
  });
}

if (!Array.prototype.flatMap) {
   
  Object.defineProperty(Array.prototype, "flatMap", {
    configurable: true,
    writable: true,
    value: function flatMap<T, U>(
      this: T[],
      cb: (value: T, index: number, array: T[]) => U | readonly U[],
      thisArg?: unknown
    ): U[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped = (this as any).map(cb, thisArg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (Array.prototype.flat as any).call(mapped, 1);
    },
  });
}

// --- String.prototype.matchAll (73) ----------------------------------------
if (!String.prototype.matchAll) {
  Object.defineProperty(String.prototype, "matchAll", {
    configurable: true,
    writable: true,
    value: function matchAll(this: string, regExp: RegExp): IterableIterator<RegExpMatchArray> {
      // 复刻规范：克隆正则（带 g 标志），循环 exec 收集结果
      const flags = regExp.flags;
      const flagsWithG = flags.includes("g") ? flags : flags + "g";
      const re = new RegExp(regExp.source, flagsWithG);
      const results: RegExpMatchArray[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(this)) !== null) {
        results.push(m);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return results.values();
    },
  });
}

// --- Array.prototype.at (92) -----------------------------------------------
if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    configurable: true,
    writable: true,
    value: function at<T>(this: T[], index: number): T | undefined {
      const len = this.length;
      const i = Math.trunc(index) || 0;
      if (i < 0) return this[len + i];
      if (i >= len) return undefined;
      return this[i];
    },
  });
}

// --- crypto.randomUUID (92) ------------------------------------------------
if (typeof gt.crypto === "object" && typeof gt.crypto.randomUUID !== "function") {
  try {
    Object.defineProperty(gt.crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: function randomUUID(): string {
        if (typeof gt.crypto.getRandomValues === "function") {
          const bytes = new Uint8Array(16);
          gt.crypto.getRandomValues(bytes);
          // 按 RFC 4122 v4 设置 version/variant 位
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          const hex = Array.from(bytes, (b) =>
            b.toString(16).padStart(2, "0")
          ).join("");
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        // 兜底：Math.random 版本（非加密安全，仅用于 id 生成）
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
          /[xy]/g,
          (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          }
        );
      },
    });
  } catch {
    /* crypto 对象只读时忽略 */
  }
}

// --- Object.hasOwn (93) ----------------------------------------------------
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: function hasOwn(object: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(object, key);
    },
  });
}

// --- structuredClone (98) --------------------------------------------------
if (typeof gt.structuredClone !== "function") {
  // 深克隆：覆盖持久化状态用到的类型（plain object/Array/Map/Set/Date/RegExp/
  // TypedArray/基本类型）。函数与 DOM 节点原样返回（真 structuredClone 会抛错，
  // 但调用方状态里不含这些类型，宽松处理比抛错更安全）。
  const deepClone = <T>(value: T, seen: Map<unknown, unknown>): T => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value) as T;

    if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags) as unknown as T;
    }
    if (value instanceof Map) {
      const copy = new Map();
      seen.set(value, copy);
      value.forEach((v, k) => copy.set(deepClone(k, seen), deepClone(v, seen)));
      return copy as unknown as T;
    }
    if (value instanceof Set) {
      const copy = new Set();
      seen.set(value, copy);
      value.forEach((v) => copy.add(deepClone(v, seen)));
      return copy as unknown as T;
    }
    if (ArrayBuffer.isView(value)) {
      // TypedArray / DataView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (value as any).slice
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((value as any).slice() as T)
        : value;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      value.forEach((item, i) => (copy[i] = deepClone(item, seen)));
      return copy as unknown as T;
    }
    // plain object（含 Object.create(null)）
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const key of Object.keys(value as object)) {
      copy[key] = deepClone(
        (value as Record<string, unknown>)[key],
        seen
      );
    }
    return copy as unknown as T;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gt as any).structuredClone = function structuredClone<T>(value: T): T {
    return deepClone(value, new Map());
  };
}

export {};
