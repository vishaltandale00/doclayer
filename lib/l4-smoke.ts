/**
 * L4 DOM smoke check (spec section d, layer 4).
 *
 * Renders the patched variant against a mock scenario HTML using JSDOM,
 * applies CSS-var overrides on :root and microcopy overrides on
 * `[data-patchable]` elements, then asserts the harness chrome is intact
 * and no injection sniff fires on the patched values. 250ms timeout.
 *
 * Two render modes:
 *   1. 'synthetic' — a minimal harness page used by unit tests for
 *      deterministic structural assertions.
 *   2. one of the 11 named scenarios (e.g. '01-bootstrap', '04-review') —
 *      loads `mocks/<scenario>.html` from disk and runs the same checks
 *      against the real scenario chrome. The injection sniff is run only
 *      against the patched VALUES (not the page's existing script tags),
 *      since real scenarios legitimately contain `<script>` for harness
 *      animation logic.
 */

import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { JsonValue } from './json-patch.ts';
import { getAt } from './json-patch.ts';
import { cssVarRegistry } from './css-vars.ts';

const SYNTHETIC_HARNESS_HTML = `<!doctype html>
<html><head><title>l4</title></head><body>
  <div class="topbar" data-region="topbar">topbar</div>
  <div class="harness-strip" data-region="harness">harness</div>
  <ol class="lifecycle-ribbon" aria-label="lifecycle"><li>1</li><li>2</li></ol>
  <main>
    <span data-patchable="series-kicker">doclayer / mocks</span>
    <span data-patchable="series-subtitle">Two writers in their own lanes.</span>
    <span data-patchable="drafting-stall-banner">stall banner placeholder</span>
  </main>
  <div class="statusbar" data-region="status">statusbar</div>
</body></html>`;

const VALID_REAL_SCENARIOS = new Set<string>([
  '00-flow', '01-bootstrap', '02-planning', '03-drafting', '04-review',
  '05-publish', '06-reader-harness', '07-multiplayer', '08-workstream',
  '09-review-loop', 'index',
]);

const INJECTION_NEEDLES = ['<script', '<iframe', 'javascript:', 'data:'];

export interface SmokeFailure {
  ok: false;
  scenario: string;
  assertion: string;
  /** Optional human-readable detail (e.g. for mock_file_missing). */
  reason?: string;
}
export interface SmokeOk {
  ok: true;
  scenario: string;
}
export type SmokeResult = SmokeOk | SmokeFailure;

interface Harness {
  html: string;
  real: boolean;
  source: string;
}

/**
 * Result of attempting to load a harness page. When the caller passed a
 * scenario id that's in the 11-scenario allowlist but the file is missing
 * or unreadable, we MUST fail closed (see `mock_file_missing` below) so a
 * misconfigured scenario can't silently pass smoke against the synthetic
 * page. The synthetic-fallback path is reserved for scenarios that are
 * genuinely not in the allowlist (e.g. variant-level cssVar-only patches
 * that don't target any specific scenario).
 */
type HarnessLoad =
  | { ok: true; harness: Harness }
  | { ok: false; reason: 'mock_file_missing' };

function loadHarness(scenario: string): HarnessLoad {
  if (scenario === 'synthetic' || !VALID_REAL_SCENARIOS.has(scenario)) {
    return {
      ok: true,
      harness: { html: SYNTHETIC_HARNESS_HTML, real: false, source: 'synthetic' },
    };
  }
  const file = path.join(process.cwd(), 'mocks', `${scenario}.html`);
  if (!existsSync(file)) {
    return { ok: false, reason: 'mock_file_missing' };
  }
  try {
    const html = readFileSync(file, 'utf-8');
    return { ok: true, harness: { html, real: true, source: file } };
  } catch {
    return { ok: false, reason: 'mock_file_missing' };
  }
}

/**
 * Sniff for injection needles in a string. Used on candidate patch values
 * (NOT the rendered page, which legitimately contains harness scripts).
 */
function sniffInjection(s: string): string | null {
  const lower = s.toLowerCase();
  for (const needle of INJECTION_NEEDLES) {
    if (lower.includes(needle)) return needle;
  }
  return null;
}

/**
 * Walk the candidate doc's microcopy and tokens and sniff each scalar string
 * for injection needles. Catches values that snuck past L2 guards in unusual
 * paths.
 */
function sniffCandidate(candidate: JsonValue): string | null {
  const stack: JsonValue[] = [candidate];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (typeof cur === 'string') {
      const hit = sniffInjection(cur);
      if (hit) return hit;
    } else if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur as { [k: string]: JsonValue })) stack.push(v);
    }
  }
  return null;
}

/**
 * Run the L4 smoke check against the candidate (post-patch) variant doc.
 * Returns the first failure, or { ok: true } on success.
 */
export function l4Smoke(candidate: JsonValue, scenario = 'synthetic'): SmokeResult {
  const start = Date.now();
  const TIMEOUT_MS = 250;

  const load = loadHarness(scenario);
  if (!load.ok) {
    // Fail-closed: the caller asked for a real scenario from the 11-scenario
    // allowlist but the corresponding mocks/<scenario>.html could not be
    // loaded. Surface this so apply.ts returns 422 SMOKE_FAILED rather than
    // silently smoke-checking against the synthetic harness.
    return {
      ok: false,
      assertion: 'mock_file_missing',
      scenario,
      reason: `mocks/${scenario}.html could not be loaded`,
    };
  }
  const harness = load.harness;

  let dom: JSDOM;
  try {
    dom = new JSDOM(harness.html, { runScripts: 'outside-only' });
  } catch (e) {
    return { ok: false, scenario, assertion: `jsdom failed: ${(e as Error).message}` };
  }
  const { document } = dom.window;
  const preBodyLen = document.body.textContent?.length ?? 0;

  // Apply CSS vars onto :root (just to exercise the registry).
  const root = document.documentElement;
  for (const entry of cssVarRegistry) {
    const v = getAt(candidate, entry.schemaPath);
    if (v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
      try {
        root.style.setProperty(entry.name, String(v));
      } catch {
        return { ok: false, scenario, assertion: `setProperty failed for ${entry.name}` };
      }
    }
  }

  // Apply microcopy: set textContent on [data-patchable] elements where a
  // matching microcopy key exists in the candidate doc.
  const microcopy = getAt(candidate, '/microcopy') as { [k: string]: JsonValue } | undefined;
  if (microcopy && typeof microcopy === 'object') {
    const nodes = document.querySelectorAll('[data-patchable]');
    nodes.forEach((el) => {
      const key = el.getAttribute('data-patchable');
      if (!key) return;
      const val = microcopy[key];
      if (typeof val === 'string') {
        el.textContent = val;
      }
    });
  }

  // Apply visibility toggles for [data-patchable-type="visible"].
  const visibility = getAt(candidate, '/visibility') as { [k: string]: JsonValue } | undefined;
  if (visibility && typeof visibility === 'object') {
    const nodes = document.querySelectorAll('[data-patchable-type="visible"]');
    nodes.forEach((el) => {
      const key = el.getAttribute('data-patchable');
      if (!key) return;
      const val = visibility[key];
      if (typeof val === 'boolean') {
        if (val) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });
  }

  if (Date.now() - start > TIMEOUT_MS) {
    return { ok: false, scenario, assertion: 'timeout' };
  }

  // Structural assertions: chrome intact. Real scenarios have these regions;
  // synthetic page has them by construction. Some scenarios (e.g. 00-flow,
  // index) may not have every region — only assert what exists in baseline.
  if (!harness.real) {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return { ok: false, scenario, assertion: '.topbar missing' };
    const harnessEl = document.querySelector('.harness-strip');
    if (!harnessEl) return { ok: false, scenario, assertion: '.harness-strip missing' };
    const statusbar = document.querySelector('.statusbar');
    if (!statusbar) return { ok: false, scenario, assertion: '.statusbar missing' };
    const lifecycle = document.querySelector('.lifecycle-ribbon');
    if (!lifecycle) return { ok: false, scenario, assertion: '.lifecycle-ribbon missing' };

    const patchables = document.querySelectorAll('[data-patchable]');
    let anyContent = false;
    patchables.forEach((el) => {
      if ((el.textContent ?? '').trim().length > 0) anyContent = true;
    });
    if (!anyContent) {
      return { ok: false, scenario, assertion: 'no [data-patchable] has content' };
    }
  } else {
    // Real scenarios: assert body has any content at all (smoke); the page
    // itself is trusted. The check that matters is the candidate-value sniff
    // below.
    if (preBodyLen === 0) {
      return { ok: false, scenario, assertion: 'real-scenario page has empty body' };
    }
  }

  // Injection sniff on the candidate (patched values), NOT on the rendered
  // doc — real scenarios legitimately contain harness <script>s, so sniffing
  // the rendered HTML always trips. We check the patch payload values.
  const candidateHit = sniffCandidate(candidate);
  if (candidateHit) {
    return { ok: false, scenario, assertion: `injection sniff matched "${candidateHit}"` };
  }

  // Body text length sanity bounds — only meaningful for synthetic; real
  // scenarios are far too dynamic (animations toggle visibility at load).
  if (!harness.real) {
    const postBodyLen = document.body.textContent?.length ?? 0;
    const lower = Math.floor(preBodyLen * 0.1);
    const upper = preBodyLen * 5;
    if (postBodyLen < lower || postBodyLen > upper) {
      return {
        ok: false,
        scenario,
        assertion: `body.textContent length ${postBodyLen} out of bounds [${lower}, ${upper}]`,
      };
    }
  }

  if (Date.now() - start > TIMEOUT_MS) {
    return { ok: false, scenario, assertion: 'timeout' };
  }
  return { ok: true, scenario };
}
