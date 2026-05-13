/**
 * POST /api/variants/apply
 *
 * Apply a doclayer variant patch (spec section h). Five-layer validation
 * pipeline: L1 Ajv-style schema/allowlist, L2 value-shape regex guards,
 * L3 envelope-macro expansion + invariants, L4 JSDOM smoke check, then the
 * transactional apply with RFC 6902 `test` op precondition.
 *
 * Storage: Neon (Vercel Postgres) via lib/db.ts. App-level ownership checks
 * replace Supabase RLS; the auth helper provisions the user's main variant
 * on first authed call.
 *
 * Error codes:
 *   401 unauthorized                  — bad/missing JWT
 *   403 forbidden                     — patch targets a variant the user doesn't own
 *   404 not found                     — variant_id missing
 *   409 SCHEMA_STALE                  — patch.schema_fp ≠ current
 *   409 VERSION_FORK_DETECTED         — concurrent apply lost the version race
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
import { requireAuth } from '../../lib/auth.ts';
import { tx } from '../../lib/db.ts';

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
  const auth = await requireAuth(req);
  if ('error' in auth) { err(res, auth.status, { error: auth.error }); return; }

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
  // Fall back to the auth-provisioned main variant if the client didn't send
  // one explicitly. This matches the Supabase-era behavior where the JWT
  // session selected the variant implicitly.
  const variantId = body.variant_id ?? auth.variant_id;
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

  // ---- Transactional apply (Neon) ----
  // Ownership check + version read + insert + supersede + audit all happen in
  // one transaction. The L3/L4 pipeline runs INSIDE the transaction too, since
  // L3 (macro expansion) needs the current doc and we need a serializable view
  // of (variant, latest_version) for the optimistic lock to mean anything.
  try {
    const result = await tx(async (client) => {
      // 1. Variant ownership. Reads the variant row inside the tx so a
      //    concurrent delete (cascade) can't race us into a phantom apply.
      const variantRes = await client.query<{ user_id: string }>(
        'select user_id from variants where id = $1',
        [variantId],
      );
      if (variantRes.rowCount === 0) {
        return { kind: 'err' as const, status: 404, body: { error: 'variant_not_found' } };
      }
      if (variantRes.rows[0].user_id !== auth.user_id) {
        return { kind: 'err' as const, status: 403, body: { error: 'forbidden' } };
      }

      // 2. Read latest version → currentDoc + prior_version_id for optimistic lock.
      const latestRes = await client.query<{ id: string; doc: JsonValue }>(
        `select id, doc from variant_doc_versions
         where variant_id = $1
         order by created_at desc
         limit 1`,
        [variantId],
      );
      const latestVersion = latestRes.rows[0] ?? null;
      const currentDoc: JsonValue =
        (latestVersion?.doc as JsonValue | undefined) ?? ({} as JsonValue);

      // 3. L3: macro expansion + invariants (needs currentDoc).
      let effectiveOps: Op[] = ops;
      let macroOpsCount = 0;
      if (macro) {
        const exp = expandMacro(macro, currentDoc);
        if (!exp.ok || !exp.ops) {
          return {
            kind: 'err' as const, status: 422,
            body: { error: 'INVARIANT_FAILED', reason: exp.reason ?? 'macro_expand_failed' },
          };
        }
        effectiveOps = [...ops, ...exp.ops];
        macroOpsCount = exp.ops.length;
      }

      // 4. L4: preview-apply on a clone (this is where test ops fire, giving
      //    us 412 PRECONDITION_FAILED).
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
            kind: 'err' as const, status: 412,
            body: {
              error: 'PRECONDITION_FAILED',
              op_index: effectiveOps.findIndex(
                (o) => o.path === VARIANT_PREFIX + e.path || docPointer(o.path) === e.path,
              ),
              expected: e.expected, actual: e.actual,
            },
          };
        }
        return {
          kind: 'err' as const, status: 422,
          body: { error: 'SCHEMA_INVALID', reason: (e as Error).message },
        };
      }

      const inv = checkBlockInvariants(previewDoc);
      if (!inv.ok) {
        return {
          kind: 'err' as const, status: 422,
          body: { error: 'INVARIANT_FAILED', reason: inv.reason ?? '' },
        };
      }

      const smoke = l4Smoke(previewDoc, scenarioId);
      if (smoke.ok === false) {
        return {
          kind: 'err' as const, status: 422,
          body: { error: 'SMOKE_FAILED', scenario: smoke.scenario, assertion: smoke.assertion },
        };
      }

      // 5. Insert patch row. spec carries the effective_ops so /undo can
      //    reconstruct the inverse without re-expanding the macro against a
      //    drifted current doc (see undo.ts comment block on macro replay).
      const specWithEffective = {
        ...body.patch,
        effective_ops: effectiveOps,
      };
      const patchRes = await client.query<{ id: string }>(
        `insert into patches
           (variant_id, comment_id, scenario_id, schema_fp, spec, status, proposed_by)
         values ($1, $2, $3, $4, $5::jsonb, 'applied', $6)
         returning id`,
        [
          variantId,
          body.patch.viewer_comment_id ?? null,
          scenarioId,
          schema_fp,
          JSON.stringify(specWithEffective),
          auth.user_id,
        ],
      );
      const patchId = patchRes.rows[0].id;

      // 6. Insert variant_doc_versions row. The UNIQUE on
      //    (variant_id, prior_version_id) is our optimistic lock — concurrent
      //    applies racing on the same prior_version_id collide here and one
      //    rolls back. We then mark applied_at on the patch.
      const versionRes = await client.query<{ id: string }>(
        `insert into variant_doc_versions
           (variant_id, doc, schema_fp, patch_id, prior_version_id)
         values ($1, $2::jsonb, $3, $4, $5)
         returning id`,
        [
          variantId,
          JSON.stringify(previewDoc),
          schema_fp,
          patchId,
          latestVersion?.id ?? null,
        ],
      );
      const versionId = versionRes.rows[0].id;

      // 7. Stamp applied_at. (status was already 'applied'; the trigger allows
      //    this update.)
      await client.query(
        'update patches set applied_at = now() where id = $1',
        [patchId],
      );

      // 8. Model B supersession: mark any prior applied patch on the same
      //    target paths. Path overlap is computed in JS over the parsed
      //    spec.ops + spec.effective_ops, since path-set intersection in SQL
      //    is awkward and the prior-applied set is tiny in practice.
      const targetPaths = new Set(
        effectiveOps.filter((o) => o.op !== 'test').map((o) => o.path),
      );
      const priorRes = await client.query<{ id: string; spec: { ops?: Op[]; effective_ops?: Op[] } }>(
        `select id, spec from patches
         where variant_id = $1
           and status = 'applied'
           and id <> $2`,
        [variantId, patchId],
      );
      const supersededIds: string[] = [];
      for (const p of priorRes.rows) {
        if (priorPatchSupersededBy(targetPaths, p.spec)) {
          supersededIds.push(p.id);
        }
      }
      if (supersededIds.length > 0) {
        await client.query(
          `update patches
             set superseded_by_id = $1,
                 status = 'superseded'
           where id = any($2::uuid[])`,
          [patchId, supersededIds],
        );
        // Audit each supersession individually so we can join them later.
        for (const sid of supersededIds) {
          await client.query(
            `insert into variant_patches_audit
               (variant_id, patch_id, user_id, action, detail)
             values ($1, $2, $3, 'superseded', $4::jsonb)`,
            [
              variantId,
              sid,
              auth.user_id,
              JSON.stringify({ superseded_by_id: patchId }),
            ],
          );
        }
      }

      // 9. Audit the apply.
      await client.query(
        `insert into variant_patches_audit
           (variant_id, patch_id, user_id, action, detail)
         values ($1, $2, $3, 'applied', $4::jsonb)`,
        [
          variantId,
          patchId,
          auth.user_id,
          JSON.stringify({
            ops_applied: effectiveOps.length,
            superseded: supersededIds,
          }),
        ],
      );

      return {
        kind: 'ok' as const,
        body: {
          version_id: versionId,
          patch_id: patchId,
          applied_ops: effectiveOps.length,
          superseded_patch_ids: supersededIds,
        },
      };
    });

    if (result.kind === 'err') {
      err(res, result.status, result.body);
      return;
    }
    res.status(200).json(result.body);
  } catch (e) {
    const pgErr = e as { code?: string; message?: string };
    if (pgErr.code === '23505') {
      // Optimistic lock lost. The client should re-read and retry.
      err(res, 409, {
        error: 'VERSION_FORK_DETECTED',
        message: 'variant has advanced — refresh and retry',
      });
      return;
    }
    if (pgErr.code === '23503') {
      // FK violation — usually a stale variant_id from the client.
      err(res, 404, { error: 'variant_not_found' });
      return;
    }
    console.error('[doclayer] apply tx failed', pgErr);
    err(res, 500, { error: 'db_error', detail: pgErr.message });
  }
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
