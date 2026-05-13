/**
 * L3 envelope macro expansion (spec section c + h).
 *
 * Two macros: insert_block, delete_block. Both expand into a sequence of
 * RFC 6902 ops that the apply pipeline runs after L1/L2.
 *
 * Invariants enforced after expansion:
 *   - /content/blocks/order is a permutation of /content/blocks/items keys
 *   - |order| ≤ 500
 *   - insert macros use a fresh ULID-format blockId not already in items
 *   - delete macros target an existing blockId
 */

import type { Op, JsonValue } from './json-patch.ts';
import { getAt } from './json-patch.ts';
import { blockIdGuard, ulidGuard } from './patch-guards.ts';

export type Macro =
  | {
      name: 'insert_block';
      blockId: string;
      position: number;
      type: 'paragraph' | 'heading' | 'callout' | 'code' | 'list' | 'h2' | 'h3';
      headingText?: string;
    }
  | {
      name: 'delete_block';
      blockId: string;
    };

export interface MacroResult {
  ok: boolean;
  reason?: string;
  ops?: Op[];
}

/**
 * Expand a macro against the current variant doc. Returns the list of ops
 * (test + add/remove + replace order) that the apply pipeline should run.
 */
export function expandMacro(macro: Macro, currentDoc: JsonValue): MacroResult {
  const items = (getAt(currentDoc, '/content/blocks/items') ?? {}) as {
    [k: string]: JsonValue;
  };
  const order = (getAt(currentDoc, '/content/blocks/order') ?? []) as string[];

  if (macro.name === 'insert_block') {
    const ulidR = ulidGuard(macro.blockId);
    if (ulidR.ok === false) return { ok: false, reason: ulidR.reason };
    // Although the ULID guard validates 26-char Crockford, the items map keys
    // use the lowercase-kebab pattern [a-z0-9-]{1,40}. ULIDs are uppercase →
    // we normalize to lowercase for storage. Re-check the lower form.
    const blockId = macro.blockId.toLowerCase();
    const idR = blockIdGuard(blockId);
    if (idR.ok === false) return { ok: false, reason: idR.reason };
    if (Object.prototype.hasOwnProperty.call(items, blockId)) {
      return { ok: false, reason: `insert_block: blockId already exists` };
    }
    if (order.length + 1 > 500) {
      return { ok: false, reason: 'insert_block: |order| > 500 after insert' };
    }
    if (macro.position < 0 || macro.position > order.length) {
      return { ok: false, reason: `insert_block: position ${macro.position} out of range` };
    }
    const newOrder = [...order];
    newOrder.splice(macro.position, 0, blockId);
    const newItem: JsonValue = {
      visible: true,
      type: macro.type,
      ...(macro.headingText !== undefined ? { headingText: macro.headingText } : {}),
    };
    // Concurrency guard: emit an RFC 6902 absence-test for the items[blockId]
    // path BEFORE the add. We test against `null` and rely on
    // `allowAbsenceTest` in applyOp to treat that as "key must not exist".
    // The expand-time hasOwnProperty check above only sees stale state — the
    // absence-test is what catches a concurrent insert that landed between
    // expand and apply. The order-replace also acts as a test by encoding
    // the prior order in a paired test on /content/blocks/order.
    const ops: Op[] = [
      { op: 'test', path: `/variant/content/blocks/items/${blockId}`, value: null },
      { op: 'add', path: `/variant/content/blocks/items/${blockId}`, value: newItem },
      { op: 'test', path: '/variant/content/blocks/order', value: order as unknown as JsonValue },
      { op: 'replace', path: '/variant/content/blocks/order', value: newOrder },
    ];
    return { ok: true, ops };
  }

  if (macro.name === 'delete_block') {
    const idR = blockIdGuard(macro.blockId);
    if (idR.ok === false) return { ok: false, reason: idR.reason };
    if (!Object.prototype.hasOwnProperty.call(items, macro.blockId)) {
      return { ok: false, reason: 'delete_block: blockId not found' };
    }
    if (!order.includes(macro.blockId)) {
      return { ok: false, reason: 'delete_block: blockId not in order' };
    }
    const newOrder = order.filter((b) => b !== macro.blockId);
    // Paired test on /content/blocks/order BEFORE the replace so undo
    // synthesis can capture the prior order array and reconstruct it.
    // Mirrors insert_block's pattern above (lines 82-83). Without this
    // test op, undo's inverseOp() has no priorTestByPath entry for the
    // order path and the inverse `replace` ends up writing null.
    const ops: Op[] = [
      { op: 'test', path: `/variant/content/blocks/items/${macro.blockId}`, value: items[macro.blockId] },
      { op: 'remove', path: `/variant/content/blocks/items/${macro.blockId}` },
      { op: 'test', path: '/variant/content/blocks/order', value: order as unknown as JsonValue },
      { op: 'replace', path: '/variant/content/blocks/order', value: newOrder },
    ];
    return { ok: true, ops };
  }

  return { ok: false, reason: 'unknown macro' };
}

/**
 * Post-expansion invariant check: order is a permutation of items keys, and
 * |order| ≤ 500.
 */
export function checkBlockInvariants(doc: JsonValue): { ok: boolean; reason?: string } {
  const items = (getAt(doc, '/content/blocks/items') ?? {}) as { [k: string]: JsonValue };
  const order = (getAt(doc, '/content/blocks/order') ?? []) as string[];
  if (order.length > 500) return { ok: false, reason: 'invariant: |order| > 500' };
  const itemKeys = Object.keys(items).sort();
  const orderSorted = [...order].sort();
  if (itemKeys.length !== orderSorted.length) {
    return { ok: false, reason: 'invariant: order vs items length mismatch' };
  }
  for (let i = 0; i < itemKeys.length; i++) {
    if (itemKeys[i] !== orderSorted[i]) {
      return { ok: false, reason: `invariant: order missing/extra blockId ${itemKeys[i]}` };
    }
  }
  return { ok: true };
}
