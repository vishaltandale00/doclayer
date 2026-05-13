/**
 * POST /api/variants/apply
 *
 * Apply a doclayer variant patch (spec section h). Five-layer validation
 * pipeline: L1 Ajv-style schema/allowlist, L2 value-shape regex guards,
 * L3 envelope-macro expansion + invariants, L4 JSDOM smoke check, then the
 * transactional apply with RFC 6902 `test` op precondition.
 *
 * Error codes:
 *   401 unauthorized                  — bad/missing JWT
 *   403 forbidden                     — patch targets a variant the user doesn't own
 *   404 not found                     — variant_id missing
 *   409 SCHEMA_STALE                  — patch.schema_fp ≠ current
 *   412 PRECONDITION_FAILED           — a test op asserted the wrong prior value
 *   422 SCHEMA_INVALID/GUARD_FAILED/INVARIANT_FAILED/SMOKE_FAILED — Lx validators
 *   500 server error                  — DB / unexpected
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import { enumerateAllowlist, isPathAllowed, pathToValidation } from '../../lib/allowlist.ts';
import { guardForLeaf, pathHasForbiddenSegments } from '../../lib/patch-guards.ts';
import {
  type Op,
  type JsonValue,
  applyOp,
  TestFailedError,
} from '../../lib/json-patch.ts';
import { expandMacro, checkBlockInvariants, type Macro } from '../../lib/macros.ts';
import { l4Smoke } from '../../lib/l4-smoke.ts';
import { getServiceClient, getUserFromAuthHeader } from '../../lib/supabase-server.ts';

const MAX_OPS = 20;
const VARIANT_PREFIX = '/variant';

const VALID_SCENARIOS = new Set<string>([
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
  'index',
]);

interface PatchBody {
  patch: {
    schema_fp: string;
    viewer_comment_id?: string;
    intent: string;
    ops: Op[];
    macro?: Macro;
    scenario_id?: string;
  };
  variant_id?: string;
  patch_id?: string;
  scenario_id?: string;
}

interface ErrorResponse {
  error: string;
  [k: string]: unknown;
}

const ALLOWLIST = enumerateAllowlist();
const LEAF_BY_PATH = new Map<string, ReturnType<typeof enumerateAllowlist>[number]>();
for (const e of ALLOWLIST) LEAF_BY_PATH.set(e.path, e);

function leafForPath(path: string) {
  // Look up the canonical leaf type for `path`, allowing for blockId substitution.
  const direct = LEAF_BY_PATH.get(path);
  if (direct) return direct;
  for (const e of ALLOWLIST) {
    if (e.path.includes('{blockId}')) {
      const re = new RegExp('^' + e.path.replace('{blockId}', '[a-z0-9-]{1,40}') + '$');
      if (re.test(path)) return e;
    }
  }
  return null;
}

/** Strip the /variant prefix from a patch path → returns the doc-relative pointer. */
function docPointer(path: string): string | null {
  if (!path.startsWith(VARIANT_PREFIX)) return null;
  const tail = path.slice(VARIANT_PREFIX.length);
  if (tail === '') return '/';
  return tail;
}

function err(res: VercelResponse, status: number, body: ErrorResponse): void {
  res.status(status).json(body);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { err(res, 405, { error: 'method_not_allowed' }); return; }

  // ---- Auth ----
  const user = await getUserFromAuthHeader(req.headers.authorization);
  if (!user) { err(res, 401, { error: 'unauthorized' }); return; }

  // ---- Body parse ----
  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { err(res, 400, { error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { err(res, 400, { error: 'body_not_object' }); return; }
  const body = raw as Partial<PatchBody>;
  if (!body.patch || typeof body.patch !== 'object') {
    err(res, 400, { error: 'missing_patch' }); return;
  }
  const { schema_fp, ops, macro, intent } = body.patch;
  if (typeof schema_fp !== 'string') { err(res, 400, { error: 'missing_schema_fp' }); return; }
  if (typeof intent !== 'string') { err(res, 400, { error: 'missing_intent' }); return; }
  if (!Array.isArray(ops)) { err(res, 400, { error: 'missing_ops' }); return; }
  if (ops.length > MAX_OPS) { err(res, 422, { error: 'SCHEMA_INVALID', reason: `>${MAX_OPS} ops` }); return; }

  // scenario_id: accept from envelope (preferred) or top-level body. Required
  // for audit data integrity and L4 per-scenario smoke. Must be one of the
  // known scenarios — guards against architect emitting arbitrary strings.
  const scenarioId: string | undefined =
    body.patch.scenario_id ?? body.scenario_id;
  if (typeof scenarioId !== 'string' || !VALID_SCENARIOS.has(scenarioId)) {
    err(res, 400, { error: 'missing_or_invalid_scenario_id' });
    return;
  }

  // ---- fp check (409 SCHEMA_STALE) ----
  const currentFp = schemaFingerprint(variantSchema as object);
  if (schema_fp !== currentFp) {
    err(res, 409, {
      error: 'SCHEMA_STALE',
      current_fp: currentFp,
      regenerate_endpoint: '/api/variants/regenerate',
    });
    return;
  }

  // ---- variant_id resolution ----
  const variantId =
    body.variant_id ??
    (typeof ops[0]?.path === 'string' && ops[0].path.startsWith('/variant') ? undefined : undefined);
  if (!variantId) { err(res, 400, { error: 'missing_variant_id' }); return; }

  // ---- L1: shape + allowlist ----
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object') {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'op not object' }); return;
    }
    if (!['test', 'add', 'remove', 'replace'].includes(op.op)) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: `bad op ${op.op}` }); return;
    }
    if (typeof op.path !== 'string' || !op.path.startsWith(VARIANT_PREFIX + '/')) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'path must start with /variant/' }); return;
    }
    if (pathHasForbiddenSegments(op.path)) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'forbidden path segment' }); return;
    }
    if (!isPathAllowed(op.path)) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'path not in allowlist' }); return;
    }
  }

  // ---- L1.5: every mutating op preceded by a test op on the same path ----
  // SECURITY: We ALWAYS pair-check user-supplied ops, including when a macro
  // is attached. A hostile architect could otherwise smuggle unpaired mutating
  // ops by attaching a valid macro envelope. Macro-emitted ops are appended
  // *after* user ops and are pre-validated by L3 (expandMacro) — those don't
  // pass through this check, but they're trusted by construction. User-supplied
  // ops are independently audited regardless of macro presence.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'test') continue;
    const prior = ops[i - 1];
    if (!prior || prior.op !== 'test' || prior.path !== op.path) {
      err(res, 422, {
        error: 'SCHEMA_INVALID', op_index: i,
        reason: 'mutating op must be preceded by test on same path',
      });
      return;
    }
  }

  // ---- L2: value-shape guards on mutating ops ----
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'remove' || op.op === 'test') continue; // remove takes no value; test value is asserted, not bound
    const leaf = leafForPath(op.path);
    if (!leaf) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'unknown leaf' }); return;
    }
    const v = pathToValidation(op.path);
    if (!v) {
      err(res, 422, { error: 'SCHEMA_INVALID', op_index: i, reason: 'no validation for leaf' }); return;
    }
    const r = guardForLeaf(leaf.type, v, op.value);
    if (r.ok === false) {
      err(res, 422, { error: 'GUARD_FAILED', op_index: i, guard: leaf.type, reason: r.reason });
      return;
    }
  }

  // ---- Load current variant doc (RLS via service-role; we still verify user_id) ----
  const supa = getServiceClient();
  const { data: variantRow, error: vErr } = await supa
    .from('variants')
    .select('id, user_id')
    .eq('id', variantId)
    .single();
  if (vErr || !variantRow) { err(res, 404, { error: 'variant_not_found' }); return; }
  if (variantRow.user_id !== user.id) { err(res, 403, { error: 'forbidden' }); return; }

  const { data: latestVersion } = await supa
    .from('variant_doc_versions')
    .select('id, doc')
    .eq('variant_id', variantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let currentDoc: JsonValue =
    (latestVersion?.doc as JsonValue | undefined) ?? ({} as JsonValue);

  // ---- L3: macro expansion + post-apply invariants ----
  let effectiveOps: Op[] = ops;
  let macroOpsCount = 0;
  if (macro) {
    const exp = expandMacro(macro, currentDoc);
    if (!exp.ok || !exp.ops) {
      err(res, 422, { error: 'INVARIANT_FAILED', reason: exp.reason ?? 'macro_expand_failed' });
      return;
    }
    // The architect's ops[] may contain test preconditions the server requires;
    // we append the macro's expansion AFTER.
    effectiveOps = [...ops, ...exp.ops];
    macroOpsCount = exp.ops.length;
  }

  // ---- L4: DOM smoke (preview apply on a clone before persisting) ----
  let previewDoc: JsonValue = currentDoc;
  const macroStart = effectiveOps.length - macroOpsCount;
  try {
    for (let i = 0; i < effectiveOps.length; i++) {
      const op = effectiveOps[i];
      const docOp: Op = { ...op, path: docPointer(op.path) ?? op.path };
      // Macro-emitted ops (trailing section) opt into RFC 6902 strictAdd and
      // absence-test semantics for the insert_block concurrency guard.
      const isMacroOp = i >= macroStart;
      previewDoc = applyOp(previewDoc, docOp,
        isMacroOp ? { strictAdd: true, allowAbsenceTest: true } : {});
    }
  } catch (e) {
    if (e instanceof TestFailedError) {
      err(res, 412, {
        error: 'PRECONDITION_FAILED',
        op_index: effectiveOps.findIndex((o) => o.path === VARIANT_PREFIX + e.path || docPointer(o.path) === e.path),
        expected: e.expected, actual: e.actual,
      });
      return;
    }
    err(res, 422, { error: 'SCHEMA_INVALID', reason: (e as Error).message }); return;
  }

  const inv = checkBlockInvariants(previewDoc);
  if (!inv.ok) { err(res, 422, { error: 'INVARIANT_FAILED', reason: inv.reason ?? '' }); return; }

  const smoke = l4Smoke(previewDoc, scenarioId);
  if (smoke.ok === false) {
    err(res, 422, { error: 'SMOKE_FAILED', scenario: smoke.scenario, assertion: smoke.assertion });
    return;
  }

  // ---- Transaction: insert patch row + version + audit + supersede ----
  // Supabase JS doesn't expose true transactions; we do best-effort sequential
  // writes with rollback-on-error by reverting the patch row insert if a
  // later step fails. The version-row INSERT is the load-bearing audit point.
  const now = new Date().toISOString();
  // Build target paths from BOTH literal user ops and any macro-expanded
  // effective_ops. Macro-only patches have effective_ops populated but the
  // raw `ops` array empty — without this, macro patches never participate
  // in supersession bookkeeping.
  const targetPaths = new Set(
    effectiveOps.filter((o) => o.op !== 'test').map((o) => o.path),
  );

  // 1. Insert the patch row (status=proposed first; flip to applied after success).
  //    Persist the EXPANDED effective ops alongside the spec so /undo can
  //    synthesize the inverse without re-expanding the macro against a
  //    drifted current doc (see undo.ts comment block on macro replay).
  const specWithEffective = {
    ...body.patch,
    effective_ops: effectiveOps,
  };
  const patchInsert = await supa
    .from('patches')
    .insert({
      variant_id: variantId,
      comment_id: body.patch.viewer_comment_id ?? null,
      scenario_id: scenarioId,
      schema_fp: schema_fp,
      spec: specWithEffective,
      status: 'proposed',
    })
    .select('id')
    .single();
  if (patchInsert.error || !patchInsert.data) {
    err(res, 500, { error: 'db_patch_insert', detail: patchInsert.error?.message });
    return;
  }
  const patchId = patchInsert.data.id as string;

  // 2. Insert variant_doc_versions row.
  //    Optimistic concurrency: variant_doc_versions has a UNIQUE constraint on
  //    (variant_id, prior_version_id). If two concurrent applies both read the
  //    same latestVersion and both reach this insert, exactly one wins; the
  //    other gets a Postgres 23505 unique violation, which we translate to
  //    409 VERSION_FORK_DETECTED. The client refetches and retries.
  const versionInsert = await supa
    .from('variant_doc_versions')
    .insert({
      variant_id: variantId,
      doc: previewDoc,
      schema_fp: schema_fp,
      patch_id: patchId,
      prior_version_id: latestVersion?.id ?? null,
    })
    .select('id')
    .single();
  if (versionInsert.error || !versionInsert.data) {
    // rollback patch
    await supa.from('patches').delete().eq('id', patchId);
    const code = (versionInsert.error as { code?: string } | null)?.code;
    if (code === '23505') {
      // Re-read the latest version so the client can retry against the new tip.
      const { data: tip } = await supa
        .from('variant_doc_versions')
        .select('id')
        .eq('variant_id', variantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      err(res, 409, {
        error: 'VERSION_FORK_DETECTED',
        message: 'variant has advanced — refresh and retry',
        latest_version_id: tip?.id ?? null,
      });
      return;
    }
    err(res, 500, { error: 'db_version_insert', detail: versionInsert.error?.message });
    return;
  }
  const versionId = versionInsert.data.id as string;

  // 3. Model B supersession: mark any prior applied patch on the same target paths.
  let supersededIds: string[] = [];
  try {
    const { data: priorApplied } = await supa
      .from('patches')
      .select('id, spec')
      .eq('variant_id', variantId)
      .eq('status', 'applied')
      .neq('id', patchId);
    if (priorApplied) {
      for (const p of priorApplied as Array<{
        id: string;
        spec: { ops?: Op[]; effective_ops?: Op[] };
      }>) {
        // Macro-only patches have empty `ops` but populated `effective_ops`;
        // mixed patches have both. Union the path sets from each so we
        // don't blind-spot macro inserts/deletes (see fix-supersession-
        // effective-ops finding).
        if (priorPatchSupersededBy(targetPaths, p.spec)) {
          supersededIds.push(p.id);
        }
      }
      if (supersededIds.length > 0) {
        await supa
          .from('patches')
          .update({ superseded_by_id: patchId, status: 'superseded' })
          .in('id', supersededIds);
      }
    }
  } catch {
    // Best-effort; not fatal — supersession is bookkeeping.
  }

  // 4. Flip patch to applied.
  await supa.from('patches').update({ status: 'applied', applied_at: now }).eq('id', patchId);

  // 5. Audit row.
  //    The patch is already applied at this point — a transient DB blip on
  //    the audit insert MUST NOT fail the request (the user's change is
  //    durable and visible). We surface the gap two ways: (a) console.error
  //    so it shows up in Vercel logs / aggregation, and (b) an optional
  //    `audit_log_warning: true` flag in the response so a client that cares
  //    can flag the state to the user.
  let auditOk = true;
  try {
    const auditInsert = await supa.from('variant_patches_audit').insert({
      variant_id: variantId,
      patch_id: patchId,
      user_id: user.id,
      action: 'applied',
      detail: { ops_applied: effectiveOps.length, superseded: supersededIds },
    });
    if (auditInsert.error) {
      auditOk = false;
      console.error('[doclayer] audit insert failed', {
        variantId, patchId, error: auditInsert.error.message,
      });
    }
  } catch (auditErr) {
    auditOk = false;
    console.error('[doclayer] audit insert threw', {
      variantId, patchId, error: (auditErr as Error).message,
    });
  }

  res.status(200).json({
    version_id: versionId,
    patch_id: patchId,
    applied_ops: effectiveOps.length,
    superseded_patch_ids: supersededIds,
    ...(auditOk ? {} : { audit_log_warning: true }),
  });
}

/**
 * Pure helper extracted so tests can verify the supersession path-union logic
 * without standing up a Postgres. Given the target paths of the incoming
 * patch and the spec of a prior applied patch, return true if the prior
 * patch touches any of the same paths. Reads BOTH `ops` and `effective_ops`
 * so macro-only patches (whose `ops` is empty but whose `effective_ops`
 * carry the actual writes) participate correctly.
 */
export function priorPatchSupersededBy(
  targetPaths: Set<string>,
  priorSpec: { ops?: Op[]; effective_ops?: Op[] } | null | undefined,
): boolean {
  if (!priorSpec) return false;
  const priorTargetPaths = new Set<string>();
  for (const o of (priorSpec.ops ?? [])) {
    if (o.op !== 'test') priorTargetPaths.add(o.path);
  }
  for (const o of (priorSpec.effective_ops ?? [])) {
    if (o.op !== 'test') priorTargetPaths.add(o.path);
  }
  for (const p of priorTargetPaths) {
    if (targetPaths.has(p)) return true;
  }
  return false;
}

// Re-export internals for tests (allows the test runner to swap the supabase
// client + skip DB writes while still exercising L1-L4).
export const _internals = {
  ALLOWLIST,
  leafForPath,
  docPointer,
};

// ---- Pure validator (used by tests + the handler) ----

export type ValidatePatchResult =
  | { ok: true; effectiveOps: Op[]; previewDoc: JsonValue }
  | { ok: false; status: number; body: ErrorResponse };

export interface ValidatePatchInput {
  patch: {
    schema_fp: string;
    intent: string;
    ops: Op[];
    macro?: Macro;
    viewer_comment_id?: string;
    scenario_id?: string;
  };
  currentDoc: JsonValue;
  /** Override scenario_id for testing; falls back to patch.scenario_id. */
  scenarioId?: string;
}

/**
 * Run L1 → L4 against a candidate patch. Pure function; no DB, no I/O beyond
 * JSDOM in L4. Returns either the post-apply preview doc + effective ops
 * (after macro expansion) or a structured error suitable for `res.status/json`.
 */
export function validatePatch(input: ValidatePatchInput): ValidatePatchResult {
  const { patch, currentDoc } = input;
  const { schema_fp, ops, macro, intent } = patch;
  const scenarioId = input.scenarioId ?? patch.scenario_id ?? 'synthetic';

  if (typeof schema_fp !== 'string') return { ok: false, status: 400, body: { error: 'missing_schema_fp' } };
  if (typeof intent !== 'string') return { ok: false, status: 400, body: { error: 'missing_intent' } };
  if (!Array.isArray(ops)) return { ok: false, status: 400, body: { error: 'missing_ops' } };
  if (ops.length > MAX_OPS) {
    return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', reason: `>${MAX_OPS} ops` } };
  }

  // fp check
  const currentFp = schemaFingerprint(variantSchema as object);
  if (schema_fp !== currentFp) {
    return {
      ok: false, status: 409,
      body: { error: 'SCHEMA_STALE', current_fp: currentFp, regenerate_endpoint: '/api/variants/regenerate' },
    };
  }

  // L1
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object') {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'op not object' } };
    }
    if (!['test', 'add', 'remove', 'replace'].includes(op.op)) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: `bad op ${op.op}` } };
    }
    if (typeof op.path !== 'string' || !op.path.startsWith(VARIANT_PREFIX + '/')) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'path must start with /variant/' } };
    }
    if (pathHasForbiddenSegments(op.path)) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'forbidden path segment' } };
    }
    if (!isPathAllowed(op.path)) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'path not in allowlist' } };
    }
  }

  // L1.5: pairing — ALWAYS enforced on user-supplied ops, even when a macro
  // is present. See apply.ts handler for the security rationale.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'test') continue;
    const prior = ops[i - 1];
    if (!prior || prior.op !== 'test' || prior.path !== op.path) {
      return {
        ok: false, status: 422,
        body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'mutating op must be preceded by test on same path' },
      };
    }
  }

  // L2
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'remove' || op.op === 'test') continue;
    const leaf = leafForPath(op.path);
    if (!leaf) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'unknown leaf' } };
    }
    const v = pathToValidation(op.path);
    if (!v) {
      return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', op_index: i, reason: 'no validation for leaf' } };
    }
    const r = guardForLeaf(leaf.type, v, op.value);
    if (r.ok === false) {
      return { ok: false, status: 422, body: { error: 'GUARD_FAILED', op_index: i, guard: leaf.type, reason: r.reason } };
    }
  }

  // L3 macro expansion
  let effectiveOps: Op[] = ops;
  let macroOpsCount = 0;
  if (macro) {
    const exp = expandMacro(macro, currentDoc);
    if (!exp.ok || !exp.ops) {
      return { ok: false, status: 422, body: { error: 'INVARIANT_FAILED', reason: exp.reason ?? 'macro_expand_failed' } };
    }
    effectiveOps = [...ops, ...exp.ops];
    macroOpsCount = exp.ops.length;
  }

  // Apply (with test ops) → preview doc.
  let previewDoc: JsonValue = currentDoc;
  const macroStart = effectiveOps.length - macroOpsCount;
  try {
    for (let i = 0; i < effectiveOps.length; i++) {
      const op = effectiveOps[i];
      const docOp: Op = { ...op, path: docPointer(op.path) ?? op.path };
      const isMacroOp = i >= macroStart;
      previewDoc = applyOp(previewDoc, docOp,
        isMacroOp ? { strictAdd: true, allowAbsenceTest: true } : {});
    }
  } catch (e) {
    if (e instanceof TestFailedError) {
      return {
        ok: false, status: 412,
        body: { error: 'PRECONDITION_FAILED', path: e.path, expected: e.expected, actual: e.actual },
      };
    }
    return { ok: false, status: 422, body: { error: 'SCHEMA_INVALID', reason: (e as Error).message } };
  }

  // Invariants
  const inv = checkBlockInvariants(previewDoc);
  if (!inv.ok) {
    return { ok: false, status: 422, body: { error: 'INVARIANT_FAILED', reason: inv.reason ?? '' } };
  }

  // L4 smoke
  const smoke = l4Smoke(previewDoc, scenarioId);
  if (smoke.ok === false) {
    return { ok: false, status: 422, body: { error: 'SMOKE_FAILED', scenario: smoke.scenario, assertion: smoke.assertion } };
  }

  return { ok: true, effectiveOps, previewDoc };
}
