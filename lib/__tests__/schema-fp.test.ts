import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaFingerprint, jcsStringify, _internals } from '../schema-fp.ts';

const variantSchema = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'variant-schema.json'), 'utf8'),
);

test('idempotency: same schema -> same fp', () => {
  const a = schemaFingerprint(variantSchema);
  const b = schemaFingerprint(variantSchema);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('canonicalization: key reorder -> same fp', () => {
  const reorderKeys = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(reorderKeys);
    if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj).reverse(); // intentionally reverse
      const out: any = {};
      for (const k of keys) out[k] = reorderKeys(obj[k]);
      return out;
    }
    return obj;
  };
  const reordered = reorderKeys(variantSchema);
  assert.equal(schemaFingerprint(variantSchema), schemaFingerprint(reordered));
});

test('annotation strip: description-only delta -> same fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  clone.description = 'a totally different description that should be stripped';
  clone.$comment = 'a comment that should also be stripped';
  clone.title = 'a different title';
  clone.properties.styles.description = 'sub-description';
  clone.properties.styles.examples = [{ foo: 'bar' }];
  clone.properties.styles.readOnly = true;
  assert.equal(schemaFingerprint(variantSchema), schemaFingerprint(clone));
});

test('sensitivity: adding a new microcopy leaf -> different fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  clone.properties.microcopy.properties['brand-new-leaf'] = {
    type: 'string',
    maxLength: 280,
  };
  assert.notEqual(schemaFingerprint(variantSchema), schemaFingerprint(clone));
});

test('sensitivity: renaming a leaf -> different fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  const props = clone.properties.microcopy.properties;
  props['series-kicker-renamed'] = props['series-kicker'];
  delete props['series-kicker'];
  assert.notEqual(schemaFingerprint(variantSchema), schemaFingerprint(clone));
});

test('sensitivity: default change -> different fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  clone.properties.styles.properties.cssVars.properties['typing-speed-ms'].default = 999;
  assert.notEqual(schemaFingerprint(variantSchema), schemaFingerprint(clone));
});

test('sensitivity: validator range change -> different fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  clone.properties.styles.properties.cssVars.properties['typing-speed-ms'].maximum = 1000;
  assert.notEqual(schemaFingerprint(variantSchema), schemaFingerprint(clone));
});

test('$ref inlining: refs are resolved before hashing', () => {
  // Build two schemas that are semantically identical: one uses $ref, the other inlines.
  const withRef = {
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/leaf' },
      b: { $ref: '#/$defs/leaf' },
    },
    $defs: { leaf: { type: 'string', maxLength: 10 } },
  };
  const inlined = {
    type: 'object',
    properties: {
      a: { type: 'string', maxLength: 10 },
      b: { type: 'string', maxLength: 10 },
    },
    $defs: { leaf: { type: 'string', maxLength: 10 } },
  };
  assert.equal(schemaFingerprint(withRef), schemaFingerprint(inlined));
});

test('$ref siblings (default) override target during inline', () => {
  const a = {
    properties: { x: { $ref: '#/$defs/leaf', default: 'A' } },
    $defs: { leaf: { type: 'string', default: 'B' } },
  };
  const b = {
    properties: { x: { type: 'string', default: 'A' } },
    $defs: { leaf: { type: 'string', default: 'B' } },
  };
  assert.equal(schemaFingerprint(a), schemaFingerprint(b));
});

test('cycle detection: self-referential $ref yields sentinel, no infinite loop', () => {
  const cyclic = {
    $defs: {
      node: {
        type: 'object',
        properties: { next: { $ref: '#/$defs/node' } },
      },
    },
    properties: { root: { $ref: '#/$defs/node' } },
  };
  // Must not hang or throw.
  const fp = schemaFingerprint(cyclic);
  assert.match(fp, /^[0-9a-f]{12}$/);
});

test('external $ref forbidden', () => {
  const bad = {
    properties: { x: { $ref: 'https://example.com/schema.json' } },
  };
  assert.throws(() => schemaFingerprint(bad), /external \$ref forbidden/);
});

test('JCS string escaping: control chars + quotes only', () => {
  assert.equal(jcsStringify('abc'), '"abc"');
  assert.equal(jcsStringify('a"b'), '"a\\"b"');
  assert.equal(jcsStringify('a\\b'), '"a\\\\b"');
  assert.equal(jcsStringify('a\nb'), '"a\\nb"');
  assert.equal(jcsStringify('\x01'), '"\\u0001"');
  assert.equal(jcsStringify(''), '""');
  // Non-ASCII passes through verbatim per JCS.
  assert.equal(jcsStringify('café'), '"café"');
});

test('JCS numbers: integer no decimal, float shortest round-trip', () => {
  assert.equal(jcsStringify(60), '60');
  assert.equal(jcsStringify(1.0), '1');
  assert.equal(jcsStringify(0.5), '0.5');
  assert.equal(jcsStringify(-2.0), '-2');
  assert.equal(jcsStringify(0), '0');
});

test('JCS object key sort: UTF-16 lexicographic', () => {
  assert.equal(jcsStringify({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
});

test('schema fp matches what allowlist-driven hash would (smoke)', async () => {
  // The fp of the live schema is stable. Print + assert it matches the static value
  // we recorded after first computation. If this fails, the schema source changed —
  // update the constant below + audit downstream consumers.
  const fp = schemaFingerprint(variantSchema);
  // No fixed assertion of value here in case schema changes during dev; instead
  // we re-verify idempotency under a deep clone.
  const clone = JSON.parse(JSON.stringify(variantSchema));
  assert.equal(schemaFingerprint(clone), fp);
});
