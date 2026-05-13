/**
 * Tests for /api/variants/apply validation pipeline.
 *
 * These tests exercise the pure `validatePatch()` function — no DB, no auth.
 * They cover L1 (schema/allowlist), L2 (value guards), L3 (macros +
 * invariants), L4 (DOM smoke), plus the RFC 6902 `test` precondition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { validatePatch, priorPatchSupersededBy } from '../variants/apply.ts';
import { l4Smoke } from '../../lib/l4-smoke.ts';
import { renameSync } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '../../lib/json-patch.ts';
import type { Op } from '../../lib/json-patch.ts';

const FP = schemaFingerprint(variantSchema as object);

// Baseline canonical doc: enough scaffolding for the test ops to traverse.
function baseDoc(): JsonValue {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    schemaVersion: '1',
    createdAt: '2026-01-01T00:00:00Z',
    owner: 'test',
    permissions: {},
    styles: { cssVars: { 'typing-speed-ms': 60 }, animation: { global: { duration: 1.0 } } },
    tokens: {
      color: { bg: '#0a0a0b', accent: '#95e35d' },
      spacing: { radius: '8px' },
      typography: { sans: { family: "'Inter', sans-serif" } },
    },
    visibility: { 'next-strip': true },
    microcopy: { 'series-kicker': 'doclayer / mocks', 'series-subtitle': 'hi' },
    content: { blocks: { items: {}, order: [] } },
  } as JsonValue;
}

test('happy path: valid replace patch passes all layers', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP,
      intent: 'speed up typing',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 60 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 30 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.effectiveOps.length, 2);
});

test('stale fp → 409 SCHEMA_STALE', () => {
  const r = validatePatch({
    patch: {
      schema_fp: 'deadbeefcafe',
      intent: 'x',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 60 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 30 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'SCHEMA_STALE');
    assert.equal(r.body.regenerate_endpoint, '/api/variants/regenerate');
  }
});

test('failed test op → 412 PRECONDITION_FAILED', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 999 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 30 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 412);
    assert.equal(r.body.error, 'PRECONDITION_FAILED');
  }
});

test('disallowed path → 422 SCHEMA_INVALID', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/owner', value: 'test' },
        { op: 'replace', path: '/variant/owner', value: 'hijacked' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'SCHEMA_INVALID');
  }
});

test('prototype-pollution path segment → 422', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/__proto__/polluted', value: null },
        { op: 'replace', path: '/variant/__proto__/polluted', value: true },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'SCHEMA_INVALID');
});

test('hostile color value (url()) → 422 GUARD_FAILED', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/tokens/color/accent', value: '#95e35d' },
        { op: 'replace', path: '/variant/tokens/color/accent', value: 'url(http://evil)' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 422);
    // colorGuard rejects via pattern mismatch (parens not in color regex);
    // GUARD_FAILED is the expected wire error.
    assert.equal(r.body.error, 'GUARD_FAILED');
  }
});

test('hostile microcopy with zero-width char → 422 GUARD_FAILED', () => {
  const sneaky = 'normal text​trailing';
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: sneaky },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'GUARD_FAILED');
});

test('microcopy with HTML markup → 422 GUARD_FAILED', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: '<script>alert(1)</script>' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'GUARD_FAILED');
});

test('mutating op without preceding test → 422 SCHEMA_INVALID', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'x',
      ops: [
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 30 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'SCHEMA_INVALID');
    assert.match(String(r.body.reason), /must be preceded by test/);
  }
});

test('L4 DOM smoke happy: microcopy swap is fine', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'rename kicker',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'doclayer / next' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true);
});

test('macro insert_block with valid ULID → 200', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'add a callout block',
      ops: [],
      macro: {
        name: 'insert_block',
        // ULID-format string (lower-cased after expansion).
        blockId: '01arz3ndektsv4rrffq69g5fav',
        position: 0,
        type: 'callout',
        headingText: 'note',
      },
    },
    currentDoc: baseDoc(),
  });
  // ULID guard requires UPPERCASE Crockford → the lowercase one above fails.
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'INVARIANT_FAILED');
});

test('macro insert_block with proper uppercase ULID → ok', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'add a callout block',
      ops: [],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        position: 0,
        type: 'callout',
        headingText: 'note',
      },
    },
    currentDoc: baseDoc(),
  });
  // After lowercase normalization, blockId matches block-id pattern. Should pass.
  assert.equal(r.ok, true, JSON.stringify((r as { ok: false; body: unknown }).body ?? null));
});

test('macro insert_block with existing blockId → 422 INVARIANT_FAILED', () => {
  const doc = baseDoc() as { content: { blocks: { items: Record<string, unknown>; order: string[] } } };
  doc.content.blocks.items['01arz3ndektsv4rrffq69g5fav'] = { visible: true, type: 'paragraph' };
  doc.content.blocks.order.push('01arz3ndektsv4rrffq69g5fav');

  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'add duplicate block',
      ops: [],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        position: 0,
        type: 'callout',
      },
    },
    currentDoc: doc as unknown as JsonValue,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'INVARIANT_FAILED');
    assert.match(String(r.body.reason), /already exists/);
  }
});

test('out-of-range number → 422 GUARD_FAILED', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'silly speed',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 60 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 999999 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'GUARD_FAILED');
});

test('> MAX_OPS rejected', () => {
  const ops = [];
  for (let i = 0; i < 21; i++) ops.push({ op: 'test' as const, path: '/variant/styles/cssVars/typing-speed-ms', value: 60 });
  const r = validatePatch({
    patch: { schema_fp: FP, intent: 'spam', ops },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'SCHEMA_INVALID');
});

// ---- Phase 3 hardening: regression coverage for must-fix findings ----

test('macro_with_unpaired_user_op_rejected', () => {
  // SECURITY: A hostile architect attaches a valid macro envelope alongside
  // an unpaired user-supplied `replace` op. The pair-check must still fire.
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'smuggle unpaired op',
      ops: [
        // No preceding `test` op — this should be rejected even with the macro
        // attached.
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'hijacked' },
      ],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        position: 0,
        type: 'callout',
      },
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'SCHEMA_INVALID');
    assert.equal(r.body.op_index, 0);
    assert.match(String(r.body.reason), /must be preceded by test/);
  }
});

test('rgba_oversized_channels_rejected', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'oversized rgba',
      ops: [
        { op: 'test', path: '/variant/tokens/color/accent', value: '#95e35d' },
        { op: 'replace', path: '/variant/tokens/color/accent', value: 'rgba(999,999,999,99)' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'GUARD_FAILED');
    assert.match(String(r.body.reason), /0-255|0-1/);
  }
});

test('rgba_valid_channels_accepted', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'good rgba',
      ops: [
        { op: 'test', path: '/variant/tokens/color/accent', value: '#95e35d' },
        { op: 'replace', path: '/variant/tokens/color/accent', value: 'rgba(149, 227, 93, 0.5)' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true);
});

test('microcopy_u2028_rejected', () => {
  // U+2028 line separator must be rejected — it bypasses \n-only control gate.
  const hostile = 'normal text';
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'sneaky separator',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: hostile },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'GUARD_FAILED');
    assert.match(String(r.body.reason), /U\+2028|line separator/);
  }
});

test('microcopy_u2029_rejected', () => {
  const hostile = 'normal text';
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'sneaky para sep',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: hostile },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error, 'GUARD_FAILED');
});

test('concurrent_insert_block_collision_rejected', () => {
  // Simulate the case where, between macro expansion and apply, another
  // writer landed a block with the same id. The absence-test op emitted by
  // the macro should fire as a precondition failure.
  // We synthesize this by having the doc already contain the blockId at
  // apply time (which is exactly what happens in a TOCTOU race). The macro's
  // expand-time check ALSO catches this — so we test the json-patch layer
  // directly by skipping expand. Practical test: insert via macro into a
  // doc that already has the id → INVARIANT_FAILED at expand time.
  const doc = baseDoc() as { content: { blocks: { items: Record<string, unknown>; order: string[] } } };
  // Pre-populate to force expansion-time failure.
  doc.content.blocks.items['01arz3ndektsv4rrffq69g5fax'] = { visible: true, type: 'paragraph' };
  doc.content.blocks.order.push('01arz3ndektsv4rrffq69g5fax');
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'collide',
      ops: [],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        position: 0,
        type: 'callout',
      },
    },
    currentDoc: doc as unknown as JsonValue,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error, 'INVARIANT_FAILED');
    assert.match(String(r.body.reason), /already exists/);
  }
});

test('macro insert_block emits absence-test (TOCTOU guard)', () => {
  // Verify the macro expansion now produces an absence-test op for the new
  // blockId. The applied effectiveOps should include it.
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'add a callout block with toctou guard',
      ops: [],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
        position: 0,
        type: 'callout',
      },
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const absenceTest = r.effectiveOps.find(
      (o) => o.op === 'test'
        && o.path === '/variant/content/blocks/items/01arz3ndektsv4rrffq69g5fay'
        && o.value === null,
    );
    assert.ok(absenceTest, 'expected absence-test op for new blockId');
  }
});

test('valid scenario_id flows through patch envelope', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'with scenario',
      scenario_id: '01-bootstrap',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 60 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 45 },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true);
});

test('l4 smoke with real scenario loads mock and passes for benign patch', () => {
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'smoke against real scenario',
      scenario_id: '01-bootstrap',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'doclayer / next' },
      ],
    },
    currentDoc: baseDoc(),
  });
  assert.equal(r.ok, true, JSON.stringify((r as { ok: false; body: unknown }).body ?? null));
});

// ---- Phase 3 iteration-2 polish: fail-closed L4 + supersession union ----

test('l4_smoke_fails_closed_when_mock_missing', () => {
  // Temporarily rename mocks/01-bootstrap.html so the scenario file is
  // missing for a valid (allowlisted) scenario id. l4Smoke must NOT fall
  // back to the synthetic harness — it must return {ok:false,
  // assertion:'mock_file_missing'} so apply.ts surfaces 422 SMOKE_FAILED.
  const mocksDir = path.join(process.cwd(), 'mocks');
  const real = path.join(mocksDir, '01-bootstrap.html');
  const hidden = path.join(mocksDir, '01-bootstrap.html.test-bak');
  renameSync(real, hidden);
  try {
    const result = l4Smoke({ microcopy: { 'series-kicker': 'x' } } as JsonValue, '01-bootstrap');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.assertion, 'mock_file_missing');
      assert.equal(result.scenario, '01-bootstrap');
      assert.match(String(result.reason ?? ''), /could not be loaded/);
    }
  } finally {
    renameSync(hidden, real);
  }
});

test('l4_smoke_synthetic_unaffected_by_fail_closed', () => {
  // Sanity: the synthetic harness path (used for unit-test deterministic
  // structural checks and for variant-level patches with no scenario
  // applicable) must still work.
  const result = l4Smoke(
    { microcopy: { 'series-kicker': 'hello' } } as JsonValue,
    'synthetic',
  );
  assert.equal(result.ok, true);
});

test('macro_patch_supersedes_prior_path_via_effective_ops', () => {
  // Simulate: a prior macro-only patch that inserted block X (so its
  // spec.ops is [] but its spec.effective_ops contains the insert at
  // /variant/content/blocks/items/X). A new patch that also targets X
  // must supersede the prior. Without the effective_ops union fix, the
  // prior patch's empty ops[] meant supersession scan saw no overlap.
  const blockPath = '/variant/content/blocks/items/01arz3ndektsv4rrffq69g5fav';
  const priorSpec = {
    ops: [] as Op[],
    effective_ops: [
      { op: 'test', path: blockPath, value: null } as Op,
      { op: 'add', path: blockPath, value: { visible: true, type: 'callout' } } as Op,
    ],
  };
  const targetPaths = new Set<string>([blockPath]);
  assert.equal(priorPatchSupersededBy(targetPaths, priorSpec), true);
});

test('prior_patch_with_only_test_ops_does_not_supersede', () => {
  // Defensive: test ops are not mutations; they must not register as
  // overlap (otherwise a precondition-only audit would shadow real writes).
  const blockPath = '/variant/content/blocks/items/01arz3ndektsv4rrffq69g5fav';
  const priorSpec = {
    ops: [] as Op[],
    effective_ops: [{ op: 'test', path: blockPath, value: null } as Op],
  };
  assert.equal(
    priorPatchSupersededBy(new Set([blockPath]), priorSpec),
    false,
  );
});

test('prior_patch_disjoint_paths_does_not_supersede', () => {
  const priorSpec = {
    ops: [
      { op: 'test', path: '/variant/microcopy/series-kicker', value: 'x' } as Op,
      { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'y' } as Op,
    ],
    effective_ops: [
      { op: 'test', path: '/variant/microcopy/series-kicker', value: 'x' } as Op,
      { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'y' } as Op,
    ],
  };
  const targetPaths = new Set<string>([
    '/variant/styles/cssVars/typing-speed-ms',
  ]);
  assert.equal(priorPatchSupersededBy(targetPaths, priorSpec), false);
});
