/**
 * Phase 7 — additional allowlist coverage (Phase 7 deliverable §2).
 *
 *   1. Spec-required allowlist paths (per patch-dsl-final.md §c) all present.
 *   2. Enumeration from schema source-of-truth cross-checks vs.
 *      `data-patchable` scan of the mock HTML files (every `data-patchable`
 *      key MUST correspond to an allowlist entry; spec section c invariant).
 *   3. Forbidden paths per spec §c are all rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  enumerateAllowlist,
  isPathAllowed,
} from '../allowlist.ts';

const MOCKS_DIR = resolve(import.meta.dirname, '..', '..', 'mocks');

// Per patch-dsl-final.md §c: the five LEAF FAMILIES must all be enumerated.
// Transcribed from scripts/autoresearch/runs/patch-dsl-v2/patch-dsl-final.md §c (canonical allowlist paths). Update both when rotating schema.
const SPEC_REQUIRED_PATH_PREFIXES = [
  '/variant/styles/cssVars/',
  '/variant/styles/animation/',
  '/variant/tokens/color/',
  '/variant/tokens/spacing/',
  '/variant/tokens/typography/',
  '/variant/microcopy/',
  '/variant/content/blocks/items/{blockId}/',
  '/variant/content/blocks/order',
];

test('spec-required: all leaf family prefixes present in allowlist', () => {
  const list = enumerateAllowlist();
  const allPaths = list.map((e) => e.path);
  for (const prefix of SPEC_REQUIRED_PATH_PREFIXES) {
    const hit = allPaths.some((p) =>
      p === prefix || p.startsWith(prefix),
    );
    assert.ok(hit, `spec-required prefix missing from allowlist: ${prefix}`);
  }
});

test('spec-required: block atoms (visible, type, headingText, calloutLabel) all present', () => {
  const list = enumerateAllowlist();
  for (const atom of ['visible', 'type', 'headingText', 'calloutLabel']) {
    const found = list.find((e) =>
      e.path === `/variant/content/blocks/items/{blockId}/${atom}`,
    );
    assert.ok(found, `spec-required block atom missing: ${atom}`);
  }
});

test('spec-forbidden: yjsSubdoc path blocked', () => {
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/some-block-id/yjsSubdoc'),
    false,
    'yjsSubdoc must be forbidden per spec §c FORBIDDEN section',
  );
});

test('spec-forbidden: prose/** path blocked', () => {
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/some-block-id/prose/text'),
    false,
    '/prose/** must be forbidden per spec §c',
  );
});

test('spec-forbidden: id, schemaVersion, createdAt, owner, permissions blocked', () => {
  for (const p of [
    '/variant/id',
    '/variant/schemaVersion',
    '/variant/createdAt',
    '/variant/owner',
    '/variant/permissions/grant',
    '/variant/scripts/onload',
    '/variant/handlers/click',
    '/variant/events/init',
  ]) {
    assert.equal(isPathAllowed(p), false, `forbidden path should be rejected: ${p}`);
  }
});

test('spec-forbidden: prototype-pollution segments blocked', () => {
  for (const p of [
    '/variant/__proto__',
    '/variant/__proto__/polluted',
    '/variant/constructor/prototype',
    '/variant/microcopy/__proto__',
  ]) {
    assert.equal(isPathAllowed(p), false, `prototype-pollution path should be rejected: ${p}`);
  }
});

test('data-patchable scan ↔ allowlist: cross-check yields no MICROCOPY orphans', () => {
  // Per Phase 7 spec: "Enumeration from schema source-of-truth matches
  // enumeration from data-patchable scan across the mocks."
  //
  // The mocks use TWO conventions:
  //   (a) Microcopy elements: data-patchable="<microcopy-key>"
  //       (no data-patchable-type attribute). Every such key MUST appear
  //       in the microcopy allowlist — otherwise patch-renderer wouldn't
  //       know how to update them.
  //   (b) Visibility elements: data-patchable="<visibility-key>-<role>"
  //       data-patchable-type="visible". Here the data-patchable string is
  //       a compound name that BEGINS with a visibility key but appends a
  //       role suffix for disambiguation in the DOM. patch-renderer maps
  //       these via prefix match in mocks/patch-renderer.js.
  //
  // We only enforce the strict ↔ allowlist match for case (a). Case (b) is
  // verified by the prefix-match assertion in the next test.
  const list = enumerateAllowlist();
  const microcopyKeys = new Set(
    list
      .filter((e) => e.type === 'microcopy')
      .map((e) => e.path.replace('/variant/microcopy/', '')),
  );

  // Microcopy data-patchable elements are those WITHOUT
  // data-patchable-type="visible". A simple co-occurrence test on the
  // surrounding 80 chars is good enough for this allowlist audit.
  const microcopyDataKeys = new Set<string>();
  for (const f of readdirSync(MOCKS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(resolve(MOCKS_DIR, f), 'utf8');
    const re = /data-patchable="([^"]+)"([^>]{0,80})/g;
    for (const m of html.matchAll(re)) {
      const key = m[1];
      const tail = m[2];
      if (key.includes("' +") || key.includes('{')) continue;
      if (tail.includes('data-patchable-type="visible"')) continue;
      microcopyDataKeys.add(key);
    }
  }

  // Cross-check: every microcopy data-patchable key in the mocks must have
  // a matching allowlist leaf in lib/variant-schema.json. No allowlist
  // override — the cross-check passes cleanly. If a mock element wants to
  // be patchable, the schema MUST enumerate it (which rotates schema_fp).
  const unexpected: string[] = [];
  for (const key of microcopyDataKeys) {
    if (microcopyKeys.has(key)) continue;
    unexpected.push(key);
  }
  assert.deepEqual(
    unexpected,
    [],
    `UNEXPECTED microcopy data-patchable keys in mocks/*.html with no allowlist entry: ${unexpected.join(', ')}. ` +
      'Either add to lib/variant-schema.json (rotates schema_fp) or remove the data-patchable attr from the mock.',
  );
});

test('data-patchable scan ↔ allowlist: every visibility compound key resolves by prefix', () => {
  // For visibility elements (data-patchable-type="visible"), the
  // data-patchable string is a compound that must start with one of the
  // visibility allowlist keys. This documents the contract used by
  // mocks/patch-renderer.js (longest-prefix match).
  const list = enumerateAllowlist();
  const visibilityKeys = list
    .filter((e) => e.type === 'visibility')
    .map((e) => e.path.replace('/variant/visibility/', ''));

  const visibilityDataKeys = new Set<string>();
  for (const f of readdirSync(MOCKS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(resolve(MOCKS_DIR, f), 'utf8');
    const re = /data-patchable="([^"]+)"([^>]{0,80})/g;
    for (const m of html.matchAll(re)) {
      const key = m[1];
      const tail = m[2];
      if (key.includes("' +") || key.includes('{')) continue;
      if (!tail.includes('data-patchable-type="visible"')) continue;
      visibilityDataKeys.add(key);
    }
  }

  const orphans: string[] = [];
  for (const key of visibilityDataKeys) {
    const hit = visibilityKeys.some((vk) => key === vk || key.startsWith(vk));
    if (!hit) orphans.push(key);
  }
  assert.deepEqual(
    orphans,
    [],
    `visibility data-patchable keys with no allowlist prefix: ${orphans.join(', ')}`,
  );
});

test('data-patchable scan ↔ allowlist: scan covers at least 30 unique keys', () => {
  // Sanity: the scan should find a meaningful number of patchable keys.
  // If this drops, either mocks lost data-patchable tags or the regex broke.
  const seen = new Set<string>();
  for (const f of readdirSync(MOCKS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(resolve(MOCKS_DIR, f), 'utf8');
    const matches = html.matchAll(/data-patchable="([^"]+)"/g);
    for (const m of matches) {
      const key = m[1];
      if (key.includes("' +") || key.includes("' + ") || key.includes('{')) continue;
      seen.add(key);
    }
  }
  assert.ok(seen.size >= 30, `expected ≥30 data-patchable keys in mocks; got ${seen.size}`);
});

test('allowlist totals: schema enumerates ≥125 unique entries (Phase 2 invariant)', () => {
  const list = enumerateAllowlist();
  assert.ok(list.length >= 125,
    `expected ≥125 allowlist entries; got ${list.length}`);
});

test('block-order path: present and validated', () => {
  const list = enumerateAllowlist();
  const order = list.find((e) => e.path === '/variant/content/blocks/order');
  assert.ok(order, 'block-order path missing');
  assert.equal(order!.type, 'block-order');
});

test('no allowlist entry shadows a forbidden segment', () => {
  // Defense in depth: nothing in the enumerated allowlist should contain
  // __proto__, constructor, prototype, yjsSubdoc, or prose anywhere.
  const list = enumerateAllowlist();
  for (const e of list) {
    for (const bad of ['__proto__', 'constructor', 'prototype', 'yjsSubdoc', 'prose']) {
      assert.ok(
        !e.path.includes(bad),
        `allowlist entry contains forbidden segment ${bad}: ${e.path}`,
      );
    }
  }
});
