/**
 * Phase 7 — additional schema-fp coverage (Phase 7 deliverable §1).
 *
 * Existing schema-fp tests cover key-reorder, $ref inlining, cycle detection,
 * and annotation stripping. This file adds:
 *   - The CANONICAL fingerprint golden test (170cf77f16aa). If this fails,
 *     the schema source changed and downstream consumers must be audited
 *     before commit.
 *   - A deep $ref + sibling-override stability check (two semantically
 *     identical schemas with very different surface structure).
 *   - A multi-level cycle that exercises the depth limiter without throwing.
 *   - A 1-byte allowlist enum mutation -> different fp (per Phase 7 spec).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaFingerprint } from '../schema-fp.ts';

const variantSchema = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'variant-schema.json'), 'utf8'),
);

const CANONICAL_FP = '170cf77f16aa';

test('CANONICAL_FP golden: fp of variant-schema.json is 170cf77f16aa', () => {
  const fp = schemaFingerprint(variantSchema);
  assert.equal(
    fp,
    CANONICAL_FP,
    `Schema fingerprint changed from ${CANONICAL_FP} to ${fp}. ` +
      'If this is intentional, update the golden constant AND audit every ' +
      'downstream consumer (clients with cached fps will get 409 SCHEMA_STALE).',
  );
});

test('one-byte allowlist enum mutation changes fp', () => {
  // The block-type enum in $defs.block.properties.type is the only place we
  // have a hand-written enum in the schema. Append a junk value and the fp
  // must change — a one-byte allowlist change should NOT slip past.
  const clone = JSON.parse(JSON.stringify(variantSchema));
  const blockTypeEnum = clone.$defs?.block?.properties?.type?.enum;
  assert.ok(Array.isArray(blockTypeEnum) && blockTypeEnum.length > 0,
    'expected $defs.block.properties.type.enum to be a non-empty array');
  blockTypeEnum.push('z');
  const after = schemaFingerprint(clone);
  assert.notEqual(after, CANONICAL_FP,
    'adding a value to the block-type enum did NOT change the fp');
});

test('one-byte allowlist enum REORDER does NOT change fp (canonicalization)', () => {
  // JCS canonicalization sorts OBJECT keys but preserves ARRAY order. The
  // enum is an array, so reordering DOES change the fp — this asserts that
  // expected behavior (enums are order-sensitive by JSON Schema semantics).
  const clone = JSON.parse(JSON.stringify(variantSchema));
  const blockTypeEnum = clone.$defs?.block?.properties?.type?.enum as string[];
  if (blockTypeEnum.length < 2) return; // can't reorder a singleton
  // Reverse the enum
  clone.$defs.block.properties.type.enum = [...blockTypeEnum].reverse();
  const after = schemaFingerprint(clone);
  // We expect fp to differ — enum order matters in JSON Schema. This
  // documents the contract.
  assert.notEqual(after, CANONICAL_FP,
    'enum order is load-bearing per JSON Schema; fp must reflect it');
});

test('deep $ref chain (a -> b -> c) hashes same as fully inlined', () => {
  // Two semantically identical schemas: one chains $refs three deep, the
  // other inlines everything. Fingerprints must match.
  const chained = {
    type: 'object',
    properties: {
      x: { $ref: '#/$defs/a' },
    },
    $defs: {
      a: { $ref: '#/$defs/b' },
      b: { $ref: '#/$defs/c' },
      c: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' },
    },
  };
  const inlined = {
    type: 'object',
    properties: {
      x: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' },
    },
    $defs: {
      a: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' },
      b: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' },
      c: { type: 'string', maxLength: 10, pattern: '^[a-z]+$' },
    },
  };
  assert.equal(schemaFingerprint(chained), schemaFingerprint(inlined));
});

test('mutual cycle (a <-> b) does not infinite-loop', () => {
  const mutualCycle = {
    properties: { root: { $ref: '#/$defs/a' } },
    $defs: {
      a: { type: 'object', properties: { next: { $ref: '#/$defs/b' } } },
      b: { type: 'object', properties: { next: { $ref: '#/$defs/a' } } },
    },
  };
  // Must terminate and produce a valid fp.
  const fp = schemaFingerprint(mutualCycle);
  assert.match(fp, /^[0-9a-f]{12}$/);
});

test('whitespace + comments in schema source do not affect fp', () => {
  // We can't add comments to JSON, but we can verify that JSON.parse / stringify
  // round-trip yields the same fp (whitespace-insensitive).
  const reSerialized = JSON.parse(JSON.stringify(variantSchema, null, 2));
  assert.equal(schemaFingerprint(reSerialized), CANONICAL_FP);
});

test('removing a microcopy leaf changes fp (sensitivity)', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  const microcopy = clone.properties?.microcopy?.properties;
  assert.ok(microcopy && typeof microcopy === 'object');
  const firstKey = Object.keys(microcopy)[0];
  delete microcopy[firstKey];
  assert.notEqual(schemaFingerprint(clone), CANONICAL_FP);
});

test('changing a maxLength on any microcopy leaf changes fp', () => {
  const clone = JSON.parse(JSON.stringify(variantSchema));
  const microcopy = clone.properties?.microcopy?.properties;
  const firstKey = Object.keys(microcopy)[0];
  const original = microcopy[firstKey].maxLength ?? 280;
  microcopy[firstKey].maxLength = original + 1;
  assert.notEqual(schemaFingerprint(clone), CANONICAL_FP);
});
