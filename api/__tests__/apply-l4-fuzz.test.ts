/**
 * Phase 7 — L4 DOM-smoke adversarial fuzzing (Phase 7 deliverable §6).
 *
 * A parameterized fuzz table. Each entry is an injection attempt that MUST
 * be rejected with a structured 422. We don't care WHICH layer rejects it
 * (defense-in-depth: L1 size limit / L2 regex guards / L4 DOM smoke all
 * contribute) — we ONLY care that NOTHING in this table slips through to
 * a 200 response.
 *
 * If you add a layer that lets one of these through, this test will turn
 * red. That's the point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { validatePatch } from '../variants/apply.ts';
import type { JsonValue, Op } from '../../lib/json-patch.ts';

const FP = schemaFingerprint(variantSchema as object);

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

// Build a `test`/`replace` op pair against a known leaf with the given hostile value.
function injectMicrocopy(value: string): Op[] {
  return [
    { op: 'test', path: '/variant/microcopy/series-kicker', value: 'doclayer / mocks' },
    { op: 'replace', path: '/variant/microcopy/series-kicker', value },
  ];
}
function injectColor(value: string): Op[] {
  return [
    { op: 'test', path: '/variant/tokens/color/accent', value: '#95e35d' },
    { op: 'replace', path: '/variant/tokens/color/accent', value },
  ];
}
function injectTypography(value: string): Op[] {
  return [
    { op: 'test', path: '/variant/tokens/typography/sans/family', value: "'Inter', sans-serif" },
    { op: 'replace', path: '/variant/tokens/typography/sans/family', value },
  ];
}

interface FuzzCase {
  name: string;
  ops: Op[];
  /**
   * 'rejected' = guard MUST reject (this is the contract).
   * 'known-gap' = documented gap, P2 followup. Test still runs and PRINTS the
   *               result, but does not fail the suite. If the guard later
   *               starts rejecting, flip to 'rejected' and remove the gap.
   */
  expected: 'rejected' | 'known-gap';
  /** Optional note explaining a known-gap. */
  gapNote?: string;
}

const FUZZ_TABLE: FuzzCase[] = [
  // 1. classic XSS
  { name: 'script-tag-in-microcopy', expected: 'rejected', ops: injectMicrocopy('<script>alert(1)</script>') },
  // 2. iframe injection
  { name: 'iframe-in-microcopy', expected: 'rejected', ops: injectMicrocopy('<iframe src="evil"></iframe>') },
  // 3. javascript: protocol via color url()
  { name: 'javascript-protocol-in-color', expected: 'rejected', ops: injectColor('url(javascript:void(0))') },
  // 4. data: URL injection
  { name: 'data-url-in-color', expected: 'rejected', ops: injectColor('url(data:text/html,<script>alert(1)</script>)') },
  // 5. legacy IE expression()
  { name: 'expression-in-color', expected: 'rejected', ops: injectColor('expression(alert(1))') },
  // 6. SVG onload (text payload)
  { name: 'svg-onload-in-microcopy', expected: 'rejected', ops: injectMicrocopy('<svg onload="alert(1)"></svg>') },
  // 7. prototype pollution path
  {
    name: 'proto-pollution-path',
    expected: 'rejected',
    ops: [
      { op: 'test', path: '/variant/__proto__/polluted', value: null },
      { op: 'add', path: '/variant/__proto__/polluted', value: true },
    ],
  },
  // 8. HTML-entity escape that decodes to <script>
  { name: 'html-entity-script', expected: 'rejected', ops: injectMicrocopy('&lt;script&gt;alert(1)&lt;/script&gt;') },
  // 9. unicode confusable < (full-width less-than U+FF1C) — closed P2 gap.
  // microcopyGuard now rejects fullwidth ＜ ＞ ＆ and other angle-bracket
  // confusables so an NFKC-normalizing downstream renderer can't smuggle
  // markup through.
  {
    name: 'unicode-confusable-fullwidth-lt',
    expected: 'rejected',
    ops: injectMicrocopy('＜script＞alert(1)＜/script＞'),
  },
  // 10. javascript: directly in typography family
  { name: 'javascript-in-typography', expected: 'rejected', ops: injectTypography('javascript:alert(1)') },
  // 11. url() in typography family
  { name: 'url-fn-in-typography', expected: 'rejected', ops: injectTypography('url(evil)') },
  // 12. oversize payload (10MB) — must be rejected at L1 or L2
  { name: 'oversize-payload', expected: 'rejected', ops: injectMicrocopy('A'.repeat(10 * 1024 * 1024)) },
  // 13. CRLF injection (header smuggling vibe — should be caught by control-char gate)
  { name: 'crlf-in-microcopy', expected: 'rejected', ops: injectMicrocopy('hi\r\nset-cookie: pwn=1') },
  // 14. null byte
  { name: 'null-byte-in-microcopy', expected: 'rejected', ops: injectMicrocopy('hi\x00there') },
  // 15. nested macro/op shape (not an XSS but malformed envelope)
  {
    name: 'opless-mutating-replace',
    expected: 'rejected',
    ops: [
      { op: 'replace', path: '/variant/microcopy/series-kicker', value: 'unpaired' },
    ],
  },
  // 16. U+2028 line separator (bypasses \n-only control-char gate).
  //     Built via String.fromCharCode so the source file does not contain
  //     the literal codepoint (which some tooling silently strips).
  {
    name: 'u2028-in-microcopy',
    expected: 'rejected',
    ops: injectMicrocopy('a' + String.fromCharCode(0x2028) + 'b'),
  },
  // 17. bidi override (RLO U+202E)
  {
    name: 'rlo-in-microcopy',
    expected: 'rejected',
    ops: injectMicrocopy('a' + String.fromCharCode(0x202e) + 'evil' + String.fromCharCode(0x202c) + 'b'),
  },
  // 18. forbidden path: yjsSubdoc
  {
    name: 'yjsSubdoc-write',
    expected: 'rejected',
    ops: [
      { op: 'test', path: '/variant/content/blocks/items/foo/yjsSubdoc', value: null },
      { op: 'add', path: '/variant/content/blocks/items/foo/yjsSubdoc', value: 'pwn' },
    ],
  },
  // 19-29. HTML-element injection variants — all should be caught by L2
  // microcopyGuard's `< > &` rejection. Defense-in-depth coverage of common
  // event-handler payloads and tag types beyond <script>/<iframe>/<svg>.
  { name: 'img-onerror', expected: 'rejected', ops: injectMicrocopy('<img src=x onerror=alert(1)>') },
  { name: 'body-onload', expected: 'rejected', ops: injectMicrocopy('<body onload=alert(1)>') },
  { name: 'div-onclick', expected: 'rejected', ops: injectMicrocopy('<div onclick=alert(1)>x</div>') },
  { name: 'div-onmouseover', expected: 'rejected', ops: injectMicrocopy('<div onmouseover=alert(1)>x</div>') },
  { name: 'input-onfocus', expected: 'rejected', ops: injectMicrocopy('<input onfocus=alert(1)>') },
  // No `< > &` in this payload — relies on the `javascript:` substring guard
  // (added alongside the Unicode confusable closure).
  { name: 'style-attr-js-url', expected: 'rejected', ops: injectMicrocopy('hello; background: url(javascript:alert(1))') },
  { name: 'meta-refresh', expected: 'rejected', ops: injectMicrocopy('<meta http-equiv=refresh content="0;url=javascript:alert(1)">') },
  { name: 'link-stylesheet', expected: 'rejected', ops: injectMicrocopy('<link rel=stylesheet href=javascript:alert(1)>') },
  { name: 'base-href', expected: 'rejected', ops: injectMicrocopy('<base href=//evil>') },
  { name: 'object-data', expected: 'rejected', ops: injectMicrocopy('<object data=javascript:alert(1)>') },
  { name: 'embed-src', expected: 'rejected', ops: injectMicrocopy('<embed src=javascript:alert(1)>') },
];

for (const fz of FUZZ_TABLE) {
  if (fz.expected === 'rejected') {
    test(`L4 fuzz: ${fz.name} → rejected with 422`, () => {
      const r = validatePatch({
        patch: { schema_fp: FP, intent: `fuzz ${fz.name}`, ops: fz.ops },
        currentDoc: baseDoc(),
      });
      assert.equal(
        r.ok,
        false,
        `FUZZ FAILURE: ${fz.name} was NOT rejected — adversarial payload slipped through!`,
      );
      if (!r.ok) {
        assert.equal(
          r.status,
          422,
          `${fz.name}: expected 422, got ${r.status} with body ${JSON.stringify(r.body)}`,
        );
        assert.ok(
          ['SCHEMA_INVALID', 'GUARD_FAILED', 'INVARIANT_FAILED', 'SMOKE_FAILED'].includes(
            String(r.body.error),
          ),
          `${fz.name}: error code ${r.body.error} is not in the expected 422 set`,
        );
      }
    });
  } else {
    test(`L4 fuzz: ${fz.name} → KNOWN-GAP (P2): ${fz.gapNote ?? ''}`, () => {
      const r = validatePatch({
        patch: { schema_fp: FP, intent: `fuzz ${fz.name}`, ops: fz.ops },
        currentDoc: baseDoc(),
      });
      // Document the current behavior. If the gap is later closed, this
      // test will start failing — at which point the maintainer should
      // flip `expected: 'rejected'` and remove the gapNote.
      if (r.ok) {
        // expected path for known-gap — payload slipped through, P2 tracked.
        assert.ok(true);
      } else {
        // The gap got closed! Make this loud so we flip the flag.
        assert.fail(
          `KNOWN-GAP ${fz.name} is now REJECTED (status=${r.status}, error=${
            (r.body as { error?: string }).error
          }). ` +
            'Update FUZZ_TABLE: flip expected to "rejected" and remove gapNote.',
        );
      }
    });
  }
}

test('L4 fuzz coverage sanity: at least 15 injection patterns tested', () => {
  assert.ok(FUZZ_TABLE.length >= 15,
    `expected ≥15 fuzz cases; have ${FUZZ_TABLE.length}`);
});
