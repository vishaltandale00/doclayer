import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateAllowlist,
  isPathAllowed,
  pathToValidation,
} from '../allowlist.ts';
import { cssVarRegistry } from '../css-vars.ts';

test('enumerateAllowlist returns expected total count', () => {
  // 1 cssVars (typing-speed-ms)
  // 1 animation (global.duration)
  // 15 color tokens
  // 5 spacing
  // 3 typography (code/sans/serif family)
  // 34 visibility
  // 61 microcopy
  // 4 block atoms (visible, type, headingText, calloutLabel) + 1 order = 5
  // 1 + 1 + 15 + 5 + 3 + 34 + 61 + 5 = 125 by unique-path count.
  //
  // Phase 0 audit's "127" count double-counts typing-speed-ms and anim-scale
  // (they appear in both the 25 css-var rows AND the 2 animation rows). The
  // canonical schema has them only once each, so the unique-path enumeration
  // is 125. Document and assert that count.
  const list = enumerateAllowlist();
  assert.equal(list.length, 125);
});

test('breakdown by leaf type', () => {
  const list = enumerateAllowlist();
  const byType: Record<string, number> = {};
  for (const e of list) byType[e.type] = (byType[e.type] ?? 0) + 1;
  assert.equal(byType['css-var'], 1);
  assert.equal(byType['animation-scale'], 1);
  assert.equal(byType['color-token'], 15);
  assert.equal(byType['spacing'], 5);
  assert.equal(byType['typography'], 3);
  assert.equal(byType['visibility'], 34);
  assert.equal(byType['microcopy'], 61);
  assert.equal(byType['block-visibility'], 1);
  assert.equal(byType['block-type'], 1);
  assert.equal(byType['block-headingText'], 1);
  assert.equal(byType['block-calloutLabel'], 1);
  assert.equal(byType['block-order'], 1);
});

test('isPathAllowed: legit microcopy path -> true', () => {
  assert.equal(isPathAllowed('/variant/microcopy/series-kicker'), true);
});

test('isPathAllowed: nonexistent microcopy path -> false', () => {
  assert.equal(isPathAllowed('/variant/microcopy/nonexistent'), false);
});

test('isPathAllowed: forbidden yjsSubdoc path -> false', () => {
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/abc/yjsSubdoc'),
    false,
  );
});

test('isPathAllowed: block instance path with valid blockId -> true', () => {
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/review-block-1/visible'),
    true,
  );
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/review-block-1/type'),
    true,
  );
});

test('isPathAllowed: block instance path with bad blockId -> false', () => {
  assert.equal(
    isPathAllowed('/variant/content/blocks/items/BAD_ID!/visible'),
    false,
  );
});

test('isPathAllowed: chrome / id / owner paths forbidden', () => {
  assert.equal(isPathAllowed('/variant/id'), false);
  assert.equal(isPathAllowed('/variant/owner'), false);
  assert.equal(isPathAllowed('/variant/scripts/x'), false);
  assert.equal(isPathAllowed('/variant/__proto__'), false);
});

test('pathToValidation: typing-speed-ms returns int/min/max', () => {
  const v = pathToValidation('/variant/styles/cssVars/typing-speed-ms');
  assert.ok(v);
  assert.equal(v!.type, 'integer');
  assert.equal(v!.minimum, 10);
  assert.equal(v!.maximum, 300);
});

test('pathToValidation: microcopy series-kicker has maxLength 80', () => {
  const v = pathToValidation('/variant/microcopy/series-kicker');
  assert.ok(v);
  assert.equal(v!.type, 'string');
  assert.equal(v!.maxLength, 80);
});

test('pathToValidation: nonexistent path -> null', () => {
  assert.equal(pathToValidation('/variant/microcopy/no-such-key'), null);
});

test('css-var registry: every CSS var entry has a matching allowlist path', () => {
  const list = enumerateAllowlist();
  const allowlistPaths = new Set(list.map((e) => e.path));
  for (const v of cssVarRegistry) {
    assert.ok(
      allowlistPaths.has(v.schemaPath),
      `cssVar ${v.name} schemaPath ${v.schemaPath} missing from allowlist`,
    );
  }
});

test('css-var registry: count is 25 (15 color + 3 typo + 5 spacing + 2 anim)', () => {
  assert.equal(cssVarRegistry.length, 25);
});

test('css-var registry: validators behave correctly', () => {
  const typing = cssVarRegistry.find((e) => e.name === '--typing-speed-ms')!;
  assert.equal(typing.validator(60), true);
  assert.equal(typing.validator(5), false);
  assert.equal(typing.validator(301), false);
  assert.equal(typing.validator('60'), false);

  const accent = cssVarRegistry.find((e) => e.name === '--accent')!;
  assert.equal(accent.validator('#95e35d'), true);
  assert.equal(accent.validator('url(evil)'), false);
  assert.equal(accent.validator('javascript:alert(1)'), false);

  const radius = cssVarRegistry.find((e) => e.name === '--r')!;
  assert.equal(radius.validator('8px'), true);
  assert.equal(radius.validator('999px'), false);
  assert.equal(radius.validator('8'), false);
});

test('every visibility entry default = true (audit invariant)', () => {
  const list = enumerateAllowlist();
  const vis = list.filter((e) => e.type === 'visibility');
  for (const e of vis) assert.equal(e.default, true, `${e.path} default not true`);
});
