/**
 * Schema fingerprint canonicalization (spec section b).
 *
 *   schema_fp = sha256(canonicalize(schema_with_refs_resolved))[:12]
 *
 * Canonicalization steps:
 *   1. Recursively inline internal $refs. External refs forbidden. Cycles -> sentinel.
 *   2. Strip validation-irrelevant annotations (description, $comment, title, examples, readOnly, writeOnly, deprecated).
 *   3. Normalize numeric values via shortest round-trip (ECMAScript Number.prototype.toString).
 *   4. Serialize via JCS (RFC 8785): lexicographic UTF-16 key sort, minimal escaping, no whitespace.
 *   5. SHA-256 of UTF-8 bytes, truncated to first 12 hex chars.
 *
 * Behaviour:
 *   - Same logical schema with reordered keys / whitespace / stripped annotations -> same fp.
 *   - Adding/removing a leaf, changing a guard, or changing a default -> different fp.
 *
 * KEPT annotations (load-bearing for validation): type, enum, const, pattern, minimum,
 * maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems,
 * uniqueItems, required, properties, additionalProperties, patternProperties, items,
 * default, format, $defs, allOf, anyOf, oneOf, not, $id, $schema.
 *
 * STRIPPED annotations: description, $comment, title, examples, readOnly, writeOnly,
 * deprecated.
 */

import { createHash } from 'crypto';

const STRIPPED_KEYWORDS = new Set([
  'description',
  '$comment',
  'title',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const CYCLE_SENTINEL = { __cycle__: true } as const;
const REF_LIMIT = 256; // guard against pathological recursion depth

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export function schemaFingerprint(schema: object): string {
  const inlined = inlineRefs(schema as JsonValue, schema as JsonValue, [], 0);
  const stripped = stripAnnotations(inlined);
  const normalized = normalizeNumbers(stripped);
  const canonical = jcsStringify(normalized);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Recursively inline internal `$ref` strings of the form `#/path/to/def`.
 * External refs (anything not starting with `#`) throw. Cycles return a sentinel.
 */
function inlineRefs(
  node: JsonValue,
  root: JsonValue,
  refStack: string[],
  depth: number,
): JsonValue {
  if (depth > REF_LIMIT) return { ...CYCLE_SENTINEL };
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, root, refStack, depth + 1));
  }

  // Object: check for $ref
  const obj = node as { [k: string]: JsonValue };
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    if (!ref.startsWith('#')) {
      throw new Error(`schema-fp: external $ref forbidden: ${ref}`);
    }
    if (refStack.includes(ref)) {
      return { ...CYCLE_SENTINEL };
    }
    const target = resolvePointer(root, ref.slice(1));
    if (target === undefined) {
      throw new Error(`schema-fp: $ref target not found: ${ref}`);
    }
    // Inline the target, then merge any sibling keys (JSON Schema 2020-12 semantics).
    const inlinedTarget = inlineRefs(target, root, [...refStack, ref], depth + 1);
    const siblings: { [k: string]: JsonValue } = {};
    let hasSiblings = false;
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref') continue;
      siblings[k] = inlineRefs(v, root, refStack, depth + 1);
      hasSiblings = true;
    }
    if (!hasSiblings) return inlinedTarget;
    if (
      inlinedTarget === null ||
      typeof inlinedTarget !== 'object' ||
      Array.isArray(inlinedTarget)
    ) {
      // Primitive ref target shouldn't have siblings, but be permissive.
      return inlinedTarget;
    }
    return { ...(inlinedTarget as { [k: string]: JsonValue }), ...siblings };
  }

  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = inlineRefs(v, root, refStack, depth + 1);
  }
  return out;
}

/**
 * Resolve a JSON Pointer fragment (RFC 6901) like "/properties/foo/$defs/bar".
 * Returns undefined if the path doesn't exist.
 */
function resolvePointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '' || pointer === '/') return root;
  const parts = pointer
    .split('/')
    .slice(1) // leading "/" produces leading ""
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: JsonValue | undefined = root;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      const obj = cur as { [k: string]: JsonValue };
      if (!Object.prototype.hasOwnProperty.call(obj, part)) return undefined;
      cur = obj[part];
    }
  }
  return cur;
}

function stripAnnotations(node: JsonValue): JsonValue {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripAnnotations);
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(k)) continue;
    out[k] = stripAnnotations(v);
  }
  return out;
}

function normalizeNumbers(node: JsonValue): JsonValue {
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) {
      throw new Error(`schema-fp: non-finite number not serializable: ${node}`);
    }
    // ECMAScript Number.prototype.toString() yields the shortest round-trip form
    // per JCS RFC 8785 §3.2.2. Integers serialize without ".0" suffix.
    // We return the original number; jcsStringify uses Number.toString().
    return node;
  }
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(normalizeNumbers);
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = normalizeNumbers(v);
  }
  return out;
}

/**
 * JCS RFC 8785 serializer.
 * - Objects: keys sorted by UTF-16 code unit order, no whitespace
 * - Arrays: order preserved
 * - Strings: minimal JSON escaping (", \, U+0000..U+001F)
 * - Numbers: ECMAScript Number.prototype.toString() (shortest round-trip)
 * - null/true/false literals
 */
export function jcsStringify(value: JsonValue): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`schema-fp: non-finite number not serializable: ${value}`);
    }
    // Use Number.prototype.toString() for shortest round-trip.
    // Note: JCS spec mandates a more nuanced algorithm for very-large floats
    // (>= 1e21 written in exponent form), but for schema fingerprints all
    // numerics are small bounded validators (min/max/maxLength/etc.). The
    // ECMAScript default toString is correct in our domain.
    return Number.prototype.toString.call(value);
  }
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => jcsStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareUtf16);
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(encodeString(k) + ':' + jcsStringify((value as { [k: string]: JsonValue })[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`schema-fp: unsupported type: ${typeof value}`);
}

/**
 * Compare two strings by UTF-16 code unit order.
 * For BMP-only strings this matches lexicographic byte order of UTF-8 too.
 */
function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

/**
 * Minimal JSON string escaping per JCS RFC 8785 §3.2.2.5:
 * Escape only ", \, and control chars U+0000..U+001F.
 * All other code points (including non-ASCII) pass through verbatim.
 */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s.charAt(i);
  }
  out += '"';
  return out;
}

// Re-export helpers for tests.
export const _internals = {
  inlineRefs,
  stripAnnotations,
  normalizeNumbers,
  jcsStringify,
  resolvePointer,
};
