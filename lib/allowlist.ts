/**
 * Allowlist enumeration from the variant schema (spec section c).
 *
 * Walks the canonical schema and emits one entry per patchable leaf path under
 *   /properties/{styles,tokens,content,visibility,microcopy}
 *
 * Each entry carries: the runtime path (`/variant/...`), the JSON-Schema path,
 * a leaf type tag, the validator constraints, and the default value.
 *
 * This is the SOURCE-OF-TRUTH for what paths a patch can touch. The architect
 * prompt embeds this enumeration; the apply endpoint's L1 check rejects any
 * path not in the list; the client renderer iterates this list at scenario
 * load to know which DOM attributes to rebind.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Inline-load the schema (avoids JSON import attribute requirements under
// Node's experimental strip-types ESM loader).
const __schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'variant-schema.json',
);
const schema = JSON.parse(readFileSync(__schemaPath, 'utf8')) as unknown as Record<
  string,
  unknown
>;

export type LeafType =
  | 'css-var'
  | 'animation-scale'
  | 'color-token'
  | 'spacing'
  | 'typography'
  | 'visibility'
  | 'microcopy'
  | 'block-visibility'
  | 'block-type'
  | 'block-headingText'
  | 'block-calloutLabel'
  | 'block-order';

export interface Validation {
  type: string;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  maxLength?: number;
  enum?: string[];
  maxItems?: number;
}

export interface AllowlistEntry {
  path: string; // /variant/styles/cssVars/typing-speed-ms
  schemaPath: string; // /properties/styles/properties/cssVars/properties/typing-speed-ms
  type: LeafType;
  validation: Validation;
  default: unknown;
}

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  patternProperties?: Record<string, JsonSchemaNode>;
  $ref?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  maxLength?: number;
  enum?: string[];
  maxItems?: number;
  items?: JsonSchemaNode;
};

function resolveRef(ref: string): JsonSchemaNode {
  // Only #/$defs/<name> style refs are used here.
  const m = ref.match(/^#\/\$defs\/([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error(`allowlist: unsupported ref ${ref}`);
  const defs = (schema as unknown as { $defs?: Record<string, JsonSchemaNode> }).$defs;
  if (!defs || !defs[m[1]]) throw new Error(`allowlist: ref target missing ${ref}`);
  return defs[m[1]];
}

function effectiveNode(node: JsonSchemaNode): JsonSchemaNode {
  if (node.$ref) {
    const base = resolveRef(node.$ref);
    // Sibling keys override the ref target (default in particular).
    return { ...base, ...node, $ref: undefined };
  }
  return node;
}

function buildValidation(node: JsonSchemaNode): Validation {
  const eff = effectiveNode(node);
  const v: Validation = { type: typeof eff.type === 'string' ? eff.type : 'string' };
  if (eff.minimum !== undefined) v.minimum = eff.minimum;
  if (eff.maximum !== undefined) v.maximum = eff.maximum;
  if (eff.pattern !== undefined) v.pattern = eff.pattern;
  if (eff.maxLength !== undefined) v.maxLength = eff.maxLength;
  if (eff.enum !== undefined) v.enum = eff.enum;
  if (eff.maxItems !== undefined) v.maxItems = eff.maxItems;
  return v;
}

/**
 * Enumerate the full allowlist for the current schema. Pure / deterministic.
 */
export function enumerateAllowlist(): AllowlistEntry[] {
  const out: AllowlistEntry[] = [];
  const props = (schema as JsonSchemaNode).properties!;

  // styles.cssVars.<name>
  const cssVars = props.styles?.properties?.cssVars?.properties ?? {};
  for (const [name, node] of Object.entries(cssVars)) {
    const eff = effectiveNode(node);
    out.push({
      path: `/variant/styles/cssVars/${name}`,
      schemaPath: `/properties/styles/properties/cssVars/properties/${name}`,
      type: 'css-var',
      validation: buildValidation(node),
      default: eff.default,
    });
  }

  // styles.animation.<group>.<param>
  const animGroups = props.styles?.properties?.animation?.properties ?? {};
  for (const [group, gnode] of Object.entries(animGroups)) {
    const gprops = gnode.properties ?? {};
    for (const [param, pnode] of Object.entries(gprops)) {
      const eff = effectiveNode(pnode);
      out.push({
        path: `/variant/styles/animation/${group}/${param}`,
        schemaPath: `/properties/styles/properties/animation/properties/${group}/properties/${param}`,
        type: 'animation-scale',
        validation: buildValidation(pnode),
        default: eff.default,
      });
    }
  }

  // tokens.color.<name>
  const colors = props.tokens?.properties?.color?.properties ?? {};
  for (const [name, node] of Object.entries(colors)) {
    const eff = effectiveNode(node);
    out.push({
      path: `/variant/tokens/color/${name}`,
      schemaPath: `/properties/tokens/properties/color/properties/${name}`,
      type: 'color-token',
      validation: buildValidation(node),
      default: eff.default,
    });
  }

  // tokens.spacing.<name>
  const spacing = props.tokens?.properties?.spacing?.properties ?? {};
  for (const [name, node] of Object.entries(spacing)) {
    const eff = effectiveNode(node);
    out.push({
      path: `/variant/tokens/spacing/${name}`,
      schemaPath: `/properties/tokens/properties/spacing/properties/${name}`,
      type: 'spacing',
      validation: buildValidation(node),
      default: eff.default,
    });
  }

  // tokens.typography.<family>.<param>
  const typo = props.tokens?.properties?.typography?.properties ?? {};
  for (const [family, fnode] of Object.entries(typo)) {
    const fprops = fnode.properties ?? {};
    for (const [param, pnode] of Object.entries(fprops)) {
      const eff = effectiveNode(pnode);
      out.push({
        path: `/variant/tokens/typography/${family}/${param}`,
        schemaPath: `/properties/tokens/properties/typography/properties/${family}/properties/${param}`,
        type: 'typography',
        validation: buildValidation(pnode),
        default: eff.default,
      });
    }
  }

  // visibility.<key>
  const visibility = props.visibility?.properties ?? {};
  for (const [name, node] of Object.entries(visibility)) {
    const eff = effectiveNode(node);
    out.push({
      path: `/variant/visibility/${name}`,
      schemaPath: `/properties/visibility/properties/${name}`,
      type: 'visibility',
      validation: buildValidation(node),
      default: eff.default,
    });
  }

  // microcopy.<key>
  const microcopy = props.microcopy?.properties ?? {};
  for (const [name, node] of Object.entries(microcopy)) {
    const eff = effectiveNode(node);
    out.push({
      path: `/variant/microcopy/${name}`,
      schemaPath: `/properties/microcopy/properties/${name}`,
      type: 'microcopy',
      validation: buildValidation(node),
      default: eff.default,
    });
  }

  // Block atoms: 5 template paths under content.blocks.items.<blockId> + order
  const blockDef = (schema as unknown as { $defs?: Record<string, JsonSchemaNode> }).$defs?.block;
  if (blockDef && blockDef.properties) {
    const blockTypeMap: Record<string, LeafType> = {
      visible: 'block-visibility',
      type: 'block-type',
      headingText: 'block-headingText',
      calloutLabel: 'block-calloutLabel',
    };
    for (const [name, node] of Object.entries(blockDef.properties)) {
      const lt = blockTypeMap[name];
      if (!lt) continue;
      const eff = effectiveNode(node);
      out.push({
        path: `/variant/content/blocks/items/{blockId}/${name}`,
        schemaPath: `/$defs/block/properties/${name}`,
        type: lt,
        validation: buildValidation(node),
        default: eff.default,
      });
    }
  }
  // blocks.order array
  const orderNode = props.content?.properties?.blocks?.properties?.order;
  if (orderNode) {
    out.push({
      path: `/variant/content/blocks/order`,
      schemaPath: `/properties/content/properties/blocks/properties/order`,
      type: 'block-order',
      validation: buildValidation(orderNode),
      default: undefined,
    });
  }

  return out;
}

/**
 * Path-allowed predicate. Accepts both template paths
 * (`/variant/content/blocks/items/{blockId}/visible`) and concrete paths with
 * a blockId substituted in (e.g. `/variant/content/blocks/items/review-block-1/visible`).
 */
export function isPathAllowed(path: string): boolean {
  const list = enumerateAllowlist();
  for (const e of list) {
    if (e.path === path) return true;
    if (e.path.includes('{blockId}')) {
      const re = new RegExp('^' + e.path.replace('{blockId}', '[a-z0-9-]{1,40}') + '$');
      if (re.test(path)) return true;
    }
  }
  return false;
}

export function pathToValidation(path: string): Validation | null {
  const list = enumerateAllowlist();
  for (const e of list) {
    if (e.path === path) return e.validation;
    if (e.path.includes('{blockId}')) {
      const re = new RegExp('^' + e.path.replace('{blockId}', '[a-z0-9-]{1,40}') + '$');
      if (re.test(path)) return e.validation;
    }
  }
  return null;
}
