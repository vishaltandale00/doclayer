/**
 * Phase 7 — supersession bookkeeping tests (Phase 7 deliverable §5).
 *
 * Model B (explicit supersession): when two patches touch overlapping
 * paths, the LATER patch supersedes the EARLIER one. The earlier patch's
 * `superseded_by_id` gets set; its status flips from 'applied' to
 * 'superseded'.
 *
 * priorPatchSupersededBy() is the pure helper that decides whether a
 * given prior patch is superseded by an incoming target-path set. We
 * test it directly without standing up a Postgres.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorPatchSupersededBy } from '../variants/apply.ts';
import type { Op } from '../../lib/json-patch.ts';

// Helper to build a "patch spec" the way apply.ts persists them.
function spec(ops: Op[], effectiveOps?: Op[]) {
  return { ops, effective_ops: effectiveOps ?? ops };
}

test('supersession: B on same path as A → A is superseded by B', () => {
  const sameMicroPath = '/variant/microcopy/series-kicker';
  const aSpec = spec([
    { op: 'test', path: sameMicroPath, value: 'orig' },
    { op: 'replace', path: sameMicroPath, value: 'A' },
  ]);
  // B's target paths include sameMicroPath
  const bTargets = new Set([sameMicroPath]);
  assert.equal(priorPatchSupersededBy(bTargets, aSpec), true,
    'A must be superseded when B replaces the same path');
});

test('supersession: disjoint paths → A is NOT superseded by B', () => {
  const aSpec = spec([
    { op: 'test', path: '/variant/microcopy/series-kicker', value: 'orig' },
    { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'A' },
  ]);
  const bTargets = new Set(['/variant/styles/cssVars/typing-speed-ms']);
  assert.equal(priorPatchSupersededBy(bTargets, aSpec), false,
    'disjoint patches must not trigger supersession');
});

test('supersession: A is macro-only (ops=[], effective_ops populated) → B overlapping macro path supersedes A', () => {
  // Regression test for the "fix-supersession-effective-ops" finding.
  // A macro-only patch has empty `ops` but populated `effective_ops`.
  // Without unioning both, the path-overlap scan would miss it.
  const blockPath = '/variant/content/blocks/items/01arz3ndektsv4rrffq69g5fav';
  const aSpec = {
    ops: [] as Op[],
    effective_ops: [
      { op: 'test', path: blockPath, value: null } as Op,
      { op: 'add', path: blockPath, value: { visible: true, type: 'callout' } } as Op,
    ],
  };
  const bTargets = new Set([blockPath]);
  assert.equal(priorPatchSupersededBy(bTargets, aSpec), true,
    'macro-only patches must participate in supersession via effective_ops');
});

test('supersession: A consists only of test ops → A is NOT superseded (no mutations to override)', () => {
  const sameMicroPath = '/variant/microcopy/series-kicker';
  const aSpec = spec([
    { op: 'test', path: sameMicroPath, value: 'x' },
  ]);
  const bTargets = new Set([sameMicroPath]);
  assert.equal(priorPatchSupersededBy(bTargets, aSpec), false,
    'test-only "patches" are audits, not writes; cannot be superseded');
});

test('supersession: empty/null prior spec → not superseded', () => {
  const bTargets = new Set(['/variant/microcopy/series-kicker']);
  assert.equal(priorPatchSupersededBy(bTargets, null), false);
  assert.equal(priorPatchSupersededBy(bTargets, undefined), false);
  assert.equal(priorPatchSupersededBy(bTargets, {}), false);
  assert.equal(priorPatchSupersededBy(bTargets, { ops: [], effective_ops: [] }), false);
});

test('supersession: partial overlap (any single path overlap → true)', () => {
  const aSpec = spec([
    { op: 'test', path: '/variant/microcopy/series-kicker', value: 'x' },
    { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'y' },
    { op: 'test', path: '/variant/microcopy/series-subtitle', value: 'x' },
    { op: 'replace', path: '/variant/microcopy/series-subtitle', value: 'y' },
  ]);
  // B touches only ONE of A's paths.
  const bTargets = new Set(['/variant/microcopy/series-subtitle']);
  assert.equal(priorPatchSupersededBy(bTargets, aSpec), true,
    'a single overlapping path is sufficient to supersede');
});

// ---- Workflow simulation (apply A → undo A → apply B; A should NOT be superseded) ----
//
// The supersession scan runs at apply-B time over patches with
// status='applied'. After /undo flips A.status='rejected', A is excluded
// from the scan filter — so B doesn't (and can't) supersede A. We assert
// this by modelling the status filter explicitly.

test('apply A → undo A → apply B: A is rejected, not superseded', () => {
  type AppliedRow = {
    id: string;
    status: 'applied' | 'rejected' | 'superseded';
    spec: { ops?: Op[]; effective_ops?: Op[] };
  };
  const sameMicroPath = '/variant/microcopy/series-kicker';
  const A: AppliedRow = {
    id: 'A',
    status: 'applied',
    spec: spec([
      { op: 'test', path: sameMicroPath, value: 'orig' },
      { op: 'replace', path: sameMicroPath, value: 'A' },
    ]),
  };
  // Undo A: status flips.
  A.status = 'rejected';

  // Apply B: scan over applied rows only.
  const applied: AppliedRow[] = [A].filter((p) => p.status === 'applied');
  const bTargets = new Set([sameMicroPath]);
  const superseded = applied.filter((p) => priorPatchSupersededBy(bTargets, p.spec));

  assert.equal(superseded.length, 0,
    'A (rejected via undo) must NOT appear in supersession results when B applies');
  assert.equal(A.status, 'rejected',
    'A remains in rejected state — not flipped to superseded by B');
});
