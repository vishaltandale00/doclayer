/**
 * Minimal RFC 6902 / RFC 6901 implementation scoped to the variant doc.
 *
 * The variant doc that lives in Supabase is the JSON under `/variant/...` —
 * the apply endpoint strips the `/variant` prefix before pointer evaluation
 * so paths line up with the document root.
 *
 * Only ops we use here: test, add, remove, replace. No move, no copy.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface Op {
  op: 'test' | 'add' | 'remove' | 'replace';
  path: string;
  value?: JsonValue;
}

const FORBIDDEN_SEGS = new Set(['__proto__', 'constructor', 'prototype']);

export function splitPointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`json-patch: pointer must start with "/": ${pointer}`);
  }
  return pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getParent(
  root: JsonValue,
  parts: string[],
): { parent: JsonValue; key: string } {
  if (parts.length === 0) throw new Error('json-patch: cannot operate on root');
  let cur: JsonValue = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') {
      throw new Error(`json-patch: traversal hit non-object at ${parts.slice(0, i).join('/')}`);
    }
    const k = parts[i];
    if (FORBIDDEN_SEGS.has(k)) throw new Error(`json-patch: forbidden segment ${k}`);
    if (Array.isArray(cur)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        throw new Error(`json-patch: bad array index ${k}`);
      }
      cur = cur[idx];
    } else {
      cur = (cur as { [k: string]: JsonValue })[k];
    }
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN_SEGS.has(last)) throw new Error(`json-patch: forbidden segment ${last}`);
  return { parent: cur, key: last };
}

export function getAt(root: JsonValue, pointer: string): JsonValue | undefined {
  const parts = splitPointer(pointer);
  if (parts.length === 0) return root;
  let cur: JsonValue | undefined = root;
  for (const k of parts) {
    if (FORBIDDEN_SEGS.has(k)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      const obj = cur as { [k: string]: JsonValue };
      if (!Object.prototype.hasOwnProperty.call(obj, k)) return undefined;
      cur = obj[k];
    }
  }
  return cur;
}

/** Deep-equal for JSON values (used by `test` op). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as { [k: string]: JsonValue };
  const bo = b as { [k: string]: JsonValue };
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!jsonEqual(ao[ak[i]], bo[bk[i]])) return false;
  }
  return true;
}

export interface ApplyOpOptions {
  /**
   * RFC 6902 strict-add: when true, an `add` op on an existing object key
   * throws PreconditionError instead of overwriting. Used by macro
   * `insert_block` to guarantee that two concurrent inserts targeting the
   * same blockId cannot silently collide.
   */
  strictAdd?: boolean;
  /**
   * Allow `test` to assert ABSENCE of a path. When true and `op.value` is
   * `null` AND the path does not exist, the test passes. This gives macros
   * a way to encode "this key must not exist yet" as an RFC 6902 precondition.
   *
   * The L2 guards reject `null` as a value for every known leaf type, so
   * `test` against `null` cannot collide with a legitimate value-equality
   * test on a user-allowlisted path. We only enable this flag for trusted
   * macro-emitted ops.
   */
  allowAbsenceTest?: boolean;
}

export function applyOp(root: JsonValue, op: Op, opts: ApplyOpOptions = {}): JsonValue {
  const parts = splitPointer(op.path);
  if (op.op === 'test') {
    const cur = getAt(root, op.path);
    if (opts.allowAbsenceTest && cur === undefined && op.value === null) {
      return root;
    }
    if (!jsonEqual(cur, op.value ?? null)) {
      throw new TestFailedError(op.path, op.value, cur);
    }
    return root;
  }
  if (parts.length === 0) {
    throw new Error('json-patch: ops against document root are forbidden');
  }
  // Need to mutate (operate on a clone so caller's input isn't touched).
  const clone = structuredClone(root);
  const { parent, key } = getParent(clone, parts);
  if (parent === null || typeof parent !== 'object') {
    throw new Error(`json-patch: parent of ${op.path} is not an object`);
  }
  if (Array.isArray(parent)) {
    const idx = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
      throw new Error(`json-patch: bad array index ${key}`);
    }
    if (op.op === 'add') parent.splice(idx, 0, op.value ?? null);
    else if (op.op === 'replace') {
      if (idx >= parent.length) throw new Error(`json-patch: replace beyond array end`);
      parent[idx] = op.value ?? null;
    } else if (op.op === 'remove') {
      if (idx >= parent.length) throw new Error(`json-patch: remove beyond array end`);
      parent.splice(idx, 1);
    }
  } else {
    const obj = parent as { [k: string]: JsonValue };
    if (op.op === 'add') {
      if (opts.strictAdd && Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new TestFailedError(op.path, undefined, obj[key]);
      }
      obj[key] = op.value ?? null;
    }
    else if (op.op === 'replace') {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new Error(`json-patch: replace on missing key ${key}`);
      }
      obj[key] = op.value ?? null;
    } else if (op.op === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new Error(`json-patch: remove on missing key ${key}`);
      }
      delete obj[key];
    }
  }
  return clone;
}

export class TestFailedError extends Error {
  path: string;
  expected: JsonValue | undefined;
  actual: JsonValue | undefined;
  constructor(path: string, expected: JsonValue | undefined, actual: JsonValue | undefined) {
    super(`json-patch: test op failed at ${path}`);
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Apply a sequence of ops in order. Throws on first failure. */
export function applyAll(root: JsonValue, ops: Op[], opts: ApplyOpOptions = {}): JsonValue {
  let cur = root;
  for (const op of ops) cur = applyOp(cur, op, opts);
  return cur;
}
