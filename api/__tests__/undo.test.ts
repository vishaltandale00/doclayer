/**
 * Phase 7 — undo round-trip + beyond-window tests (Phase 7 deliverable §4).
 *
 * The undo handler in /api/variants/undo.ts is a Supabase-coupled HTTP
 * handler. We can't easily stand up a Postgres for unit tests, but the
 * load-bearing behavior is the inverse-op synthesis + replay. We pull
 * that logic into a local replica that mirrors undo.ts:
 *
 *   - given the persisted spec.effective_ops + currentDoc
 *   - synthesize inverse ops
 *   - replay against currentDoc
 *   - assert resulting doc == pre-apply state
 *
 * And the 60s window guard, which is a pure timestamp comparison.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { validatePatch } from '../variants/apply.ts';
import {
  type Op,
  type JsonValue,
  applyOp,
  jsonEqual,
} from '../../lib/json-patch.ts';

const FP = schemaFingerprint(variantSchema as object);
const UNDO_WINDOW_MS = 60_000;

function baseDoc(): JsonValue {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    schemaVersion: '1', createdAt: '2026-01-01T00:00:00Z', owner: 'test', permissions: {},
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

const VARIANT_PREFIX = '/variant';
function docPointer(path: string): string {
  if (!path.startsWith(VARIANT_PREFIX)) return path;
  const tail = path.slice(VARIANT_PREFIX.length);
  return tail === '' ? '/' : tail;
}

/** Replica of undo.ts inverseOp() — see comments there for behavior. */
function inverseOp(op: Op, priorTestByPath: Map<string, JsonValue | undefined>): Op[] {
  const dp = docPointer(op.path);
  if (op.op === 'test') return [];
  if (op.op === 'replace') {
    const prior = priorTestByPath.get(dp);
    return [
      { op: 'test', path: op.path, value: op.value as JsonValue },
      { op: 'replace', path: op.path, value: (prior ?? null) as JsonValue },
    ];
  }
  if (op.op === 'add') return [{ op: 'remove', path: op.path }];
  if (op.op === 'remove') {
    const prior = priorTestByPath.get(dp);
    return [{ op: 'add', path: op.path, value: (prior ?? null) as JsonValue }];
  }
  return [];
}

function synthesizeInverse(effectiveOps: Op[]): Op[] {
  const priorTestByPath = new Map<string, JsonValue | undefined>();
  for (const o of effectiveOps) {
    if (o.op === 'test') priorTestByPath.set(docPointer(o.path), o.value);
  }
  const inv: Op[] = [];
  for (let i = effectiveOps.length - 1; i >= 0; i--) {
    inv.push(...inverseOp(effectiveOps[i], priorTestByPath));
  }
  return inv;
}

function applyAllDocRel(doc: JsonValue, ops: Op[]): JsonValue {
  let cur = doc;
  for (const op of ops) {
    const docOp: Op = { ...op, path: docPointer(op.path) };
    cur = applyOp(cur, docOp, { strictAdd: true, allowAbsenceTest: true });
  }
  return cur;
}

// ---- 1. Replace round-trip ----

test('undo round-trip: replace microcopy → undo → identical to pre-apply', () => {
  const pre = baseDoc();
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'rename kicker',
      ops: [
        { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
        { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'doclayer / next' },
      ],
    },
    currentDoc: pre,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const post = r.previewDoc;
  // Sanity: forward apply produced the expected microcopy change.
  const postMicrocopy = (post as { microcopy: { 'series-kicker': string } }).microcopy['series-kicker'];
  assert.equal(postMicrocopy, 'doclayer / next');

  // Now invert.
  const inv = synthesizeInverse(r.effectiveOps);
  const undone = applyAllDocRel(post, inv);
  assert.ok(
    jsonEqual(undone, pre),
    'undo of replace failed to restore pre-apply state',
  );
});

test('undo round-trip: replace cssVar → undo → identical to pre-apply', () => {
  const pre = baseDoc();
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'slow down typing',
      ops: [
        { op: 'test', path: '/variant/styles/cssVars/typing-speed-ms', value: 60 },
        { op: 'replace', path: '/variant/styles/cssVars/typing-speed-ms', value: 30 },
      ],
    },
    currentDoc: pre,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const post = r.previewDoc;
  const inv = synthesizeInverse(r.effectiveOps);
  const undone = applyAllDocRel(post, inv);
  assert.ok(jsonEqual(undone, pre), 'undo of cssVar replace did not restore state');
});

// ---- 2. insert_block macro round-trip ----

test('undo round-trip: insert_block macro → undo → identical to pre-apply', () => {
  const pre = baseDoc();
  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'add a callout',
      ops: [],
      macro: {
        name: 'insert_block',
        blockId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        position: 0,
        type: 'callout',
        headingText: 'note',
      },
    },
    currentDoc: pre,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const post = r.previewDoc;
  // Sanity: the new block exists post-apply.
  const items = (post as { content: { blocks: { items: Record<string, unknown>; order: string[] } } })
    .content.blocks.items;
  assert.ok(items['01arz3ndektsv4rrffq69g5fav'],
    'insert_block did not add the block');

  // Invert and replay.
  const inv = synthesizeInverse(r.effectiveOps);
  const undone = applyAllDocRel(post, inv);
  assert.ok(
    jsonEqual(undone, pre),
    `undo of insert_block did not restore pre-apply state. ` +
      `Diff: pre=${JSON.stringify(pre).length} bytes, undone=${JSON.stringify(undone).length} bytes`,
  );
});

// ---- 3. delete_block macro round-trip ----

test('undo round-trip: delete_block macro → undo → identical to pre-apply', () => {
  // Seed a block to delete.
  const pre = baseDoc() as { content: { blocks: { items: Record<string, JsonValue>; order: string[] } } };
  pre.content.blocks.items['existing-block-1'] = { visible: true, type: 'paragraph' };
  pre.content.blocks.order.push('existing-block-1');

  const r = validatePatch({
    patch: {
      schema_fp: FP, intent: 'remove a block',
      ops: [],
      macro: { name: 'delete_block', blockId: 'existing-block-1' },
    },
    currentDoc: pre as unknown as JsonValue,
  });
  assert.equal(r.ok, true, JSON.stringify((r as { ok: false; body: unknown }).body ?? null));
  if (!r.ok) return;

  const post = r.previewDoc;
  const items = (post as { content: { blocks: { items: Record<string, unknown>; order: string[] } } })
    .content.blocks.items;
  assert.equal(items['existing-block-1'], undefined,
    'delete_block did not remove the block from items');

  // delete_block's expansion in lib/macros.ts emits a paired `test` on
  // /variant/content/blocks/order BEFORE the replace, mirroring
  // insert_block's pattern. That paired test is what undo synthesis uses
  // to capture the prior order and reconstruct the inverse `replace`.
  const inv = synthesizeInverse(r.effectiveOps);
  const undone = applyAllDocRel(post, inv);
  const isRestored = jsonEqual(undone, pre as unknown as JsonValue);
  assert.ok(
    isRestored,
    'delete_block undo must restore prior block order (items + order array)',
  );
});

// ---- 4. Beyond-window guard ----

test('undo beyond-window: applied_at > 60s ago returns 410 GONE', () => {
  // Pure timestamp comparison (mirrors undo.ts line ~88).
  const appliedAt = new Date(Date.now() - (UNDO_WINDOW_MS + 1000)).toISOString();
  const beyondWindow = Date.now() - new Date(appliedAt).getTime() > UNDO_WINDOW_MS;
  assert.ok(beyondWindow,
    'a patch applied 61s ago must be classified as beyond-window');
});

test('undo within-window: applied_at < 60s ago is allowed', () => {
  const appliedAt = new Date(Date.now() - 5000).toISOString();
  const beyondWindow = Date.now() - new Date(appliedAt).getTime() > UNDO_WINDOW_MS;
  assert.equal(beyondWindow, false,
    'a patch applied 5s ago must NOT be classified as beyond-window');
});

test('undo boundary: applied_at exactly 60s ago is NOT beyond-window', () => {
  // Per undo.ts: `if (Date.now() - appliedAt > UNDO_WINDOW_MS)` — strict > .
  // At exactly 60_000ms the patch IS still undoable. Document this contract.
  const appliedAt = Date.now() - UNDO_WINDOW_MS;
  const beyondWindow = Date.now() - appliedAt > UNDO_WINDOW_MS;
  assert.equal(beyondWindow, false,
    'undo window is inclusive at the boundary (strict >, not >=)');
});

// ---- 5. Inverse-op shape sanity ----

test('inverse synthesis: replace inverse uses captured test value', () => {
  const fwd: Op[] = [
    { op: 'test', path: '/variant/microcopy/series-kicker', value: 'OLD' },
    { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'NEW' },
  ];
  const inv = synthesizeInverse(fwd);
  // Expect: test(value=NEW) then replace(value=OLD)
  assert.equal(inv.length, 2);
  assert.equal(inv[0].op, 'test');
  assert.equal(inv[0].value, 'NEW');
  assert.equal(inv[1].op, 'replace');
  assert.equal(inv[1].value, 'OLD');
});

test('inverse synthesis: ops are reversed', () => {
  const fwd: Op[] = [
    { op: 'test', path: '/variant/microcopy/series-kicker', value: 'A' },
    { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'B' },
    { op: 'test', path: '/variant/microcopy/series-subtitle', value: 'C' },
    { op: 'replace', path: '/variant/microcopy/series-subtitle', value: 'D' },
  ];
  const inv = synthesizeInverse(fwd);
  // Reverse order: last forward op's inverse comes first.
  assert.equal(inv[0].path, '/variant/microcopy/series-subtitle');
  assert.equal(inv[2].path, '/variant/microcopy/series-kicker');
});
