/**
 * POST /api/variants/undo
 *
 * Undo a previously-applied patch within a 60s window (spec section h).
 * Inverse synthesis from the patch's captured `test` values.
 *
 * Storage: Neon (Vercel Postgres) via lib/db.ts. App-level ownership checks
 * replace Supabase RLS. The full undo (version row + patch status flip +
 * superseded-restoration + audit) runs in a single transaction.
 *
 * Body: { patch_id: string }
 *
 * Error codes:
 *   401 unauthorized
 *   403 forbidden
 *   404 not found
 *   409 VERSION_FORK_DETECTED — concurrent write lost the version race
 *   410 GONE                 — beyond 60s window, or already-undone patch
 *   412 PRECONDITION_FAILED  — inverse-apply test op failed against current doc
 *   500 server error
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { tx } from '../../lib/db.ts';
import {
  type Op,
  type JsonValue,
  applyOp,
  TestFailedError,
} from '../../lib/json-patch.ts';

const UNDO_WINDOW_MS = 60_000;
const VARIANT_PREFIX = '/variant';

function docPointer(path: string): string {
  if (!path.startsWith(VARIANT_PREFIX)) return path;
  const tail = path.slice(VARIANT_PREFIX.length);
  return tail === '' ? '/' : tail;
}

/**
 * Build the inverse op for one forward op given the captured test value.
 * `priorTestByPath` maps doc-relative path → captured test value.
 */
function inverseOp(op: Op, priorTestByPath: Map<string, JsonValue | undefined>): Op[] {
  const dp = docPointer(op.path);
  if (op.op === 'test') return []; // tests aren't replayed in inverse
  if (op.op === 'replace') {
    const prior = priorTestByPath.get(dp);
    return [
      { op: 'test', path: op.path, value: op.value as JsonValue },
      { op: 'replace', path: op.path, value: (prior ?? null) as JsonValue },
    ];
  }
  if (op.op === 'add') {
    return [{ op: 'remove', path: op.path }];
  }
  if (op.op === 'remove') {
    const prior = priorTestByPath.get(dp);
    return [{ op: 'add', path: op.path, value: (prior ?? null) as JsonValue }];
  }
  return [];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; }
  }
  const body = (raw ?? {}) as { patch_id?: string };
  if (typeof body.patch_id !== 'string') {
    res.status(400).json({ error: 'missing_patch_id' }); return;
  }

  try {
    const result = await tx(async (client) => {
      // 1. Load the patch + join the owning variant for the ownership check.
      const patchRes = await client.query<{
        id: string;
        variant_id: string;
        spec: { ops?: Op[]; effective_ops?: Op[] };
        status: string;
        applied_at: string | null;
        schema_fp: string;
        owner_user_id: string;
      }>(
        `select p.id, p.variant_id, p.spec, p.status, p.applied_at, p.schema_fp,
                v.user_id as owner_user_id
         from patches p
         join variants v on v.id = p.variant_id
         where p.id = $1`,
        [body.patch_id],
      );
      if (patchRes.rowCount === 0) {
        return { kind: 'err' as const, status: 404, body: { error: 'patch_not_found' } };
      }
      const patch = patchRes.rows[0];
      if (patch.owner_user_id !== auth.user_id) {
        return { kind: 'err' as const, status: 403, body: { error: 'forbidden' } };
      }
      if (!patch.applied_at || patch.status !== 'applied') {
        return { kind: 'err' as const, status: 410, body: { error: 'NOT_APPLIED' } };
      }
      const appliedAt = new Date(patch.applied_at).getTime();
      if (Date.now() - appliedAt > UNDO_WINDOW_MS) {
        return {
          kind: 'err' as const, status: 410,
          body: { error: 'UNDO_WINDOW_EXPIRED', applied_at: patch.applied_at },
        };
      }

      // 2. Latest version row → currentDoc + prior_version_id for optimistic lock.
      const latestRes = await client.query<{ id: string; doc: JsonValue }>(
        `select id, doc from variant_doc_versions
         where variant_id = $1
         order by created_at desc
         limit 1`,
        [patch.variant_id],
      );
      const latestVersion = latestRes.rows[0] ?? null;
      const currentDoc: JsonValue =
        (latestVersion?.doc as JsonValue | undefined) ?? ({} as JsonValue);

      // 3. Inverse synthesis: replay against the CAPTURED expanded ops, not
      //    against the current doc. The doc may have drifted within the 60s
      //    window. Re-expanding a macro against the live doc would produce
      //    inverse ops referencing the wrong state, silently corrupting the
      //    variant. apply.ts persisted the expanded ops in spec.effective_ops;
      //    we use those verbatim.
      const spec = patch.spec ?? {};
      const forwardOps: Op[] = spec.effective_ops ?? spec.ops ?? [];
      const priorTestByPath = new Map<string, JsonValue | undefined>();
      for (const o of forwardOps) {
        if (o.op === 'test') priorTestByPath.set(docPointer(o.path), o.value);
      }
      const inverseOps: Op[] = [];
      for (let i = forwardOps.length - 1; i >= 0; i--) {
        inverseOps.push(...inverseOp(forwardOps[i], priorTestByPath));
      }

      // 4. Apply inverse ops to currentDoc to compute the restored state.
      let nextDoc: JsonValue = currentDoc;
      try {
        for (const op of inverseOps) {
          const docOp: Op = { ...op, path: docPointer(op.path) };
          nextDoc = applyOp(nextDoc, docOp);
        }
      } catch (e) {
        if (e instanceof TestFailedError) {
          return {
            kind: 'err' as const, status: 412,
            body: {
              error: 'PRECONDITION_FAILED',
              path: e.path, expected: e.expected, actual: e.actual,
            },
          };
        }
        return {
          kind: 'err' as const, status: 422,
          body: { error: 'undo_apply_failed', reason: (e as Error).message },
        };
      }

      // 5. Insert the post-undo version row. The unique
      //    (variant_id, prior_version_id) constraint is our optimistic lock.
      const versionRes = await client.query<{ id: string }>(
        `insert into variant_doc_versions
           (variant_id, doc, schema_fp, patch_id, prior_version_id)
         values ($1, $2::jsonb, $3, $4, $5)
         returning id`,
        [
          patch.variant_id,
          JSON.stringify(nextDoc),
          patch.schema_fp,
          patch.id,
          latestVersion?.id ?? null,
        ],
      );
      const versionId = versionRes.rows[0].id;

      // 6. Flip the original patch to 'undone'. The immutability trigger
      //    permits status changes.
      await client.query(
        `update patches set status = 'undone' where id = $1`,
        [patch.id],
      );

      // 7. Restore any patches this one had superseded — flip them back to
      //    applied. Their original applied_at remains; we deliberately do
      //    NOT extend their undo window.
      const restoredRes = await client.query<{ id: string }>(
        `update patches
           set superseded_by_id = null,
               status = 'applied'
         where superseded_by_id = $1
         returning id`,
        [patch.id],
      );
      const restoredIds = restoredRes.rows.map((r) => r.id);

      // 8. Audit.
      await client.query(
        `insert into variant_patches_audit
           (variant_id, patch_id, user_id, action, detail)
         values ($1, $2, $3, 'undone', $4::jsonb)`,
        [
          patch.variant_id,
          patch.id,
          auth.user_id,
          JSON.stringify({ restored_patch_ids: restoredIds }),
        ],
      );

      return {
        kind: 'ok' as const,
        body: {
          version_id: versionId,
          restored_patch_ids: restoredIds,
          doc: nextDoc,
        },
      };
    });

    if (result.kind === 'err') {
      res.status(result.status).json(result.body);
      return;
    }
    res.status(200).json(result.body);
  } catch (e) {
    const pgErr = e as { code?: string; message?: string };
    if (pgErr.code === '23505') {
      res.status(409).json({
        error: 'VERSION_FORK_DETECTED',
        message: 'variant has advanced since undo started — refresh and retry',
      });
      return;
    }
    console.error('[doclayer] undo tx failed', pgErr);
    res.status(500).json({ error: 'db_error', detail: pgErr.message });
  }
}
