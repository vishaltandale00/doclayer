/**
 * L2 value-shape guards for patch op values (spec section e).
 *
 * Each guard returns `{ ok: true }` or `{ ok: false, reason }`. The reason
 * string is surfaced to clients in the 422 GUARD_FAILED structured error.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string };

const CSSVAR_ALLOWED = /^[\w\s().,#%/+\-*]+$/;
const CSSVAR_BANNED = ['url(', 'expression(', 'javascript:', 'data:', '@import', '/*', '*/', '\\'];

/** Hardened CSS-var string guard (spec section e). */
export function cssVarGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'css-var: not a string' };
  if (s.length === 0) return { ok: false, reason: 'css-var: empty string' };
  if (s.length > 120) return { ok: false, reason: 'css-var: length > 120' };
  if (!CSSVAR_ALLOWED.test(s)) return { ok: false, reason: 'css-var: disallowed characters' };
  const lower = s.toLowerCase();
  for (const b of CSSVAR_BANNED) {
    if (lower.includes(b)) return { ok: false, reason: `css-var: banned substring "${b}"` };
  }
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return { ok: false, reason: 'css-var: unbalanced parens' };
  }
  if (depth !== 0) return { ok: false, reason: 'css-var: unbalanced parens' };
  return { ok: true };
}

/**
 * L2 microcopy guard. NFC-normalize, reject invisibles + bidi + BOM + control
 * chars (except \n), reject HTML markup chars `< > &`, length ≤ 280 chars after
 * NFC.
 */
export function microcopyGuard(s: unknown, maxLen = 280): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'microcopy: not a string' };
  const n = s.normalize('NFC');
  if (n.length > maxLen) return { ok: false, reason: `microcopy: length > ${maxLen} after NFC` };
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    // zero-width / bidi / invisibles / BOM
    if (c >= 0x200b && c <= 0x200f) return { ok: false, reason: 'microcopy: zero-width / bidi char' };
    if (c >= 0x202a && c <= 0x202e) return { ok: false, reason: 'microcopy: bidi override' };
    if (c >= 0x2060 && c <= 0x206f) return { ok: false, reason: 'microcopy: invisible char' };
    if (c === 0x2028) return { ok: false, reason: 'microcopy: line separator U+2028' };
    if (c === 0x2029) return { ok: false, reason: 'microcopy: paragraph separator U+2029' };
    if (c === 0xfeff) return { ok: false, reason: 'microcopy: BOM' };
    // controls except \n
    if (c < 0x20 && c !== 0x0a) return { ok: false, reason: 'microcopy: control char' };
    if (c === 0x3c || c === 0x3e || c === 0x26) {
      return { ok: false, reason: 'microcopy: HTML markup char (< > &)' };
    }
  }
  return { ok: true };
}

const COLOR_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_NAMED = new Set([
  'black', 'white', 'transparent', 'currentColor',
  'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown',
  'gray', 'grey', 'cyan', 'magenta', 'lime', 'navy', 'olive', 'teal',
  'silver', 'maroon', 'fuchsia', 'aqua',
]);
// rgb()/rgba() with integer channel values 0-255 and optional alpha 0-1.
// No percentages or units allowed inside channels.
const COLOR_RGBA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)$/;

export function colorGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'color: not a string' };
  if (s.length > 80) return { ok: false, reason: 'color: length > 80' };
  if (COLOR_HEX_RE.test(s)) return { ok: true };
  if (COLOR_NAMED.has(s)) return { ok: true };
  const m = s.match(COLOR_RGBA_RE);
  if (m) {
    const [, r, g, b, a] = m;
    const ri = parseInt(r, 10);
    const gi = parseInt(g, 10);
    const bi = parseInt(b, 10);
    if (ri < 0 || ri > 255 || gi < 0 || gi > 255 || bi < 0 || bi > 255) {
      return { ok: false, reason: 'color: rgb channels must be 0-255' };
    }
    if (a !== undefined) {
      const af = parseFloat(a);
      if (!Number.isFinite(af) || af < 0 || af > 1) {
        return { ok: false, reason: 'color: alpha must be 0-1' };
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: 'color: must be hex, named, or rgb/rgba(...)' };
}

const SPACING_RE = /^[0-9]+(px|em|rem|%)$/;

export function spacingGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'spacing: not a string' };
  if (s.length > 12) return { ok: false, reason: 'spacing: length > 12' };
  if (!SPACING_RE.test(s)) return { ok: false, reason: 'spacing: pattern mismatch' };
  return { ok: true };
}

const FONT_FAMILY_RE = /^[A-Za-z0-9 ,_'"\-]+$/;

export function fontFamilyGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'fontFamily: not a string' };
  if (s.length > 180) return { ok: false, reason: 'fontFamily: length > 180' };
  if (!FONT_FAMILY_RE.test(s)) return { ok: false, reason: 'fontFamily: pattern mismatch' };
  const lower = s.toLowerCase();
  for (const b of ['url(', 'javascript:', 'data:', 'expression(', '/*', '*/', '\\']) {
    if (lower.includes(b)) return { ok: false, reason: `fontFamily: banned substring "${b}"` };
  }
  return { ok: true };
}

/**
 * Number range guard for animation/css-var integer/number leaves.
 */
export function numberGuard(
  v: unknown,
  opts: { min?: number; max?: number; integer?: boolean },
): GuardResult {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, reason: 'number: not finite' };
  }
  if (opts.integer && !Number.isInteger(v)) {
    return { ok: false, reason: 'number: not integer' };
  }
  if (opts.min !== undefined && v < opts.min) {
    return { ok: false, reason: `number: < ${opts.min}` };
  }
  if (opts.max !== undefined && v > opts.max) {
    return { ok: false, reason: `number: > ${opts.max}` };
  }
  return { ok: true };
}

export function booleanGuard(v: unknown): GuardResult {
  if (typeof v !== 'boolean') return { ok: false, reason: 'boolean: not a boolean' };
  return { ok: true };
}

export function blockIdGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'blockId: not a string' };
  if (!/^[a-z0-9-]{1,40}$/.test(s)) return { ok: false, reason: 'blockId: pattern mismatch' };
  return { ok: true };
}

/** Fresh ULID format guard (Crockford base32, 26 chars). */
export function ulidGuard(s: unknown): GuardResult {
  if (typeof s !== 'string') return { ok: false, reason: 'ulid: not a string' };
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) return { ok: false, reason: 'ulid: pattern mismatch' };
  return { ok: true };
}

import type { LeafType, Validation } from './allowlist.ts';

/**
 * Route the L2 guard for a given leaf type. Falls back to numberGuard for
 * animation-scale (numeric) and css-var (numeric per the registered leaf —
 * `typing-speed-ms` is an integer). String css-var values would route to
 * cssVarGuard, but the only css-var leaf in v1 is the integer typing-speed-ms.
 */
export function guardForLeaf(type: LeafType, validation: Validation, value: unknown): GuardResult {
  switch (type) {
    case 'css-var':
      if (validation.type === 'string') return cssVarGuard(value);
      return numberGuard(value, {
        min: validation.minimum,
        max: validation.maximum,
        integer: validation.type === 'integer',
      });
    case 'animation-scale':
      return numberGuard(value, {
        min: validation.minimum,
        max: validation.maximum,
        integer: validation.type === 'integer',
      });
    case 'color-token':
      return colorGuard(value);
    case 'spacing':
      return spacingGuard(value);
    case 'typography':
      return fontFamilyGuard(value);
    case 'visibility':
    case 'block-visibility':
      return booleanGuard(value);
    case 'microcopy':
    case 'block-headingText':
      return microcopyGuard(value, validation.maxLength ?? 280);
    case 'block-calloutLabel':
      return microcopyGuard(value, validation.maxLength ?? 80);
    case 'block-type':
      if (typeof value !== 'string') return { ok: false, reason: 'block-type: not a string' };
      if (validation.enum && !validation.enum.includes(value)) {
        return { ok: false, reason: 'block-type: not in enum' };
      }
      return { ok: true };
    case 'block-order':
      if (!Array.isArray(value)) return { ok: false, reason: 'block-order: not an array' };
      if (validation.maxItems !== undefined && value.length > validation.maxItems) {
        return { ok: false, reason: `block-order: > ${validation.maxItems} items` };
      }
      for (const id of value) {
        const r = blockIdGuard(id);
        if (r.ok === false) return r;
      }
      return { ok: true };
    default:
      return { ok: false, reason: `unknown leaf type: ${type}` };
  }
}

/**
 * Path segment prototype-pollution guard (spec section c forbids __proto__,
 * constructor, prototype anywhere in the path).
 */
export function pathHasForbiddenSegments(path: string): boolean {
  const segs = path.split('/');
  for (const s of segs) {
    if (s === '__proto__' || s === 'constructor' || s === 'prototype') return true;
  }
  return false;
}
