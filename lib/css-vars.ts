/**
 * CSS variable registry: maps every patchable CSS custom property name
 * (`--foo`) to its canonical schema path, the scenarios that read it, and
 * a runtime validator.
 *
 * Used by:
 *   - patch-renderer.js (client): finds the right schemaPath to read for each
 *     `[data-patchable]` element's bound CSS var.
 *   - apply endpoint (server): cross-checks scenario coverage when validating
 *     "this patch is scoped correctly".
 *   - schema-evolution tooling: a new CSS var must be added here AND to the
 *     schema before the fingerprint will pick it up.
 *
 * Source-of-truth: scripts/build/doclayer-variants-v1/patchable-surface.md
 * (25 CSS variables + 2 animation scales = 27 entries — the animation scales
 * `--typing-speed-ms` and `--anim-scale` overlap with the cssVars/animation
 * entries by design; both representations are kept so the registry is keyable
 * by either name).
 */

export interface CssVarEntry {
  name: string; // --typing-speed-ms (CSS custom property name with double-dash)
  schemaPath: string; // /variant/styles/cssVars/typing-speed-ms
  scenarios: string[]; // ['03-drafting', '00-flow', ...]
  validator: (value: unknown) => boolean;
  default: string | number;
}

const colorTokenRe =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|black|white|transparent|currentColor|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|cyan|magenta|lime|navy|olive|teal|silver|maroon|fuchsia|aqua)$/;

const isColor = (v: unknown): boolean =>
  typeof v === 'string' && v.length <= 80 && colorTokenRe.test(v);

const isSpacing =
  (max: number) =>
  (v: unknown): boolean => {
    if (typeof v !== 'string' || v.length > 12) return false;
    const m = v.match(/^(\d+)(px|em|rem|%)$/);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 0 && n <= max;
  };

const fontFamilyRe = /^[A-Za-z0-9 ,_'\"\-]+$/;
const isFontFamily = (v: unknown): boolean =>
  typeof v === 'string' &&
  v.length <= 180 &&
  fontFamilyRe.test(v) &&
  !/url\(|javascript:|data:|expression\(|\/\*|\*\/|\\\\/.test(v.toLowerCase());

const ALL = [
  'index',
  '00-flow',
  '01-bootstrap',
  '02-planning',
  '03-drafting',
  '04-review',
  '05-publish',
  '06-reader-harness',
  '07-multiplayer',
  '08-workstream',
  '09-review-loop',
];

export const cssVarRegistry: CssVarEntry[] = [
  // Colors (15)
  { name: '--bg', schemaPath: '/variant/tokens/color/bg', scenarios: ALL, validator: isColor, default: '#0a0a0b' },
  { name: '--panel', schemaPath: '/variant/tokens/color/panel', scenarios: ALL, validator: isColor, default: '#131316' },
  { name: '--panel-2', schemaPath: '/variant/tokens/color/panel-2', scenarios: ALL, validator: isColor, default: '#1a1a1f' },
  { name: '--border', schemaPath: '/variant/tokens/color/border', scenarios: ALL, validator: isColor, default: '#26262c' },
  { name: '--border-soft', schemaPath: '/variant/tokens/color/border-soft', scenarios: ALL, validator: isColor, default: '#1f1f25' },
  { name: '--text', schemaPath: '/variant/tokens/color/text', scenarios: ALL, validator: isColor, default: '#ebebef' },
  { name: '--text-2', schemaPath: '/variant/tokens/color/text-2', scenarios: ALL, validator: isColor, default: '#b0b0b8' },
  { name: '--text-muted', schemaPath: '/variant/tokens/color/text-muted', scenarios: ALL, validator: isColor, default: '#6a6a74' },
  { name: '--accent', schemaPath: '/variant/tokens/color/accent', scenarios: ALL, validator: isColor, default: '#95e35d' },
  { name: '--accent-soft', schemaPath: '/variant/tokens/color/accent-soft', scenarios: ALL, validator: isColor, default: '#95e35d22' },
  { name: '--accent-2', schemaPath: '/variant/tokens/color/accent-2', scenarios: ALL, validator: isColor, default: '#7a9a6e' },
  { name: '--vishal', schemaPath: '/variant/tokens/color/vishal', scenarios: ALL, validator: isColor, default: '#6ba0ff' },
  { name: '--akhil', schemaPath: '/variant/tokens/color/akhil', scenarios: ALL, validator: isColor, default: '#ff8aa8' },
  { name: '--warn', schemaPath: '/variant/tokens/color/warn', scenarios: ALL, validator: isColor, default: '#ffb86b' },
  { name: '--third', schemaPath: '/variant/tokens/color/third', scenarios: ALL, validator: isColor, default: '#b58acc' },
  // Typography (3)
  { name: '--code', schemaPath: '/variant/tokens/typography/code/family', scenarios: ALL, validator: isFontFamily, default: "'IBM Plex Mono', monospace" },
  { name: '--sans', schemaPath: '/variant/tokens/typography/sans/family', scenarios: ALL, validator: isFontFamily, default: "'Inter', sans-serif" },
  { name: '--serif', schemaPath: '/variant/tokens/typography/serif/family', scenarios: ['06-reader-harness'], validator: isFontFamily, default: "'Iowan Old Style', serif" },
  // Spacing (5)
  { name: '--r', schemaPath: '/variant/tokens/spacing/radius', scenarios: ALL, validator: isSpacing(24), default: '8px' },
  { name: '--r-lg', schemaPath: '/variant/tokens/spacing/radius-lg', scenarios: ALL, validator: isSpacing(32), default: '14px' },
  { name: '--row-topbar', schemaPath: '/variant/tokens/spacing/row-topbar', scenarios: ALL, validator: isSpacing(80), default: '44px' },
  { name: '--row-harness', schemaPath: '/variant/tokens/spacing/row-harness', scenarios: ALL, validator: isSpacing(48), default: '27px' },
  { name: '--row-status', schemaPath: '/variant/tokens/spacing/row-status', scenarios: ALL, validator: isSpacing(48), default: '28px' },
  // Animation knobs (2)
  {
    name: '--typing-speed-ms',
    schemaPath: '/variant/styles/cssVars/typing-speed-ms',
    scenarios: ['03-drafting', '00-flow', '09-review-loop'],
    validator: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 300,
    default: 60,
  },
  {
    name: '--anim-scale',
    schemaPath: '/variant/styles/animation/global/duration',
    scenarios: ALL,
    validator: (v) => typeof v === 'number' && v >= 0.5 && v <= 2.0,
    default: 1.0,
  },
];

export function findByVarName(name: string): CssVarEntry | undefined {
  return cssVarRegistry.find((e) => e.name === name);
}

export function findByScenario(scenarioId: string): CssVarEntry[] {
  return cssVarRegistry.filter((e) => e.scenarios.includes(scenarioId));
}
