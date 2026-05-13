/**
 * POST /api/variants/undo
 *
 * Undo a previously-applied patch within a 60s window (spec section h).
 * Inverse synthesis from the patch's captured `test` values.
 *
 * Body: { patch_id: string }
 *
 * Error codes:
 *   401 unauthorized
 *   403 forbidden
 *   404 not found
 *   410 GONE                 — beyond 60s window
 *   500 server error
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServiceClient, getUserFromAuthHeader } from '../../lib/supabase-server.ts';
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

  const user = await getUserFromAuthHeader(req.headers.authorization);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; } }
  const body = (raw ?? {}) as { patch_id?: string };
  if (typeof body.patch_id !== 'string') { res.status(400).json({ error: 'missing_patch_id' }); return; }

  const supa = getServiceClient();
  const { data: patch, error: pErr } = await supa
    .from('patches')
    .select('id, variant_id, spec, status, applied_at, superseded_by_id')
    .eq('id', body.patch_id)
    .single();
  if (pErr || !patch) { res.status(404).json({ error: 'patch_not_found' }); return; }
  if (!patch.applied_at || patch.status !== 'applied') {
    res.status(410).json({ error: 'NOT_APPLIED' }); return;
  }
  const appliedAt = new Date(patch.applied_at as string).getTime();
  if (Date.now() - appliedAt > UNDO_WINDOW_MS) {
    res.status(410).json({ error: 'UNDO_WINDOW_EXPIRED', applied_at: patch.applied_at });
    return;
  }

  // Variant ownership
  const { data: variantRow } = await supa
    .from('variants').select('id, user_id').eq('id', patch.variant_id).single();
  if (!variantRow) { res.status(404).json({ error: 'variant_not_found' }); return; }
  if (variantRow.user_id !== user.id) { res.status(403).json({ error: 'forbidden' }); return; }

  // Load current doc.
  const { data: latestVersion } = await supa
    .from('variant_doc_versions')
    .select('id, doc')
    .eq('variant_id', patch.variant_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let currentDoc: JsonValue = (latestVersion?.doc as JsonValue | undefined) ?? ({} as JsonValue);

  // Inverse synthesis: replay against the CAPTURED expanded ops, not against
  // the current doc. This is essential because the doc may have drifted —
  // other patches may have applied in the 60s undo window. Re-expanding a
  // macro against the live doc would produce inverse ops referencing the
  // wrong state, silently corrupting the variant. Apply persisted the
  // expanded ops in spec.effective_ops; we use those verbatim.
  const spec = (patch.spec ?? {}) as { ops?: Op[]; effective_ops?: Op[] };
  const forwardOps: Op[] = spec.effective_ops ?? spec.ops ?? [];
  const priorTestByPath = new Map<string, JsonValue | undefined>();
  for (const o of forwardOps) {
    if (o.op === 'test') priorTestByPath.set(docPointer(o.path), o.value);
  }

  // Synthesize inverse ops (reversed order).
  const inverseOps: Op[] = [];
  for (let i = forwardOps.length - 1; i >= 0; i--) {
    inverseOps.push(...inverseOp(forwardOps[i], priorTestByPath));
  }

  // Apply inverse ops to current doc.
  let nextDoc: JsonValue = currentDoc;
  try {
    for (const op of inverseOps) {
      const docOp: Op = { ...op, path: docPointer(op.path) };
      nextDoc = applyOp(nextDoc, docOp);
    }
  } catch (e) {
    if (e instanceof TestFailedError) {
      res.status(412).json({ error: 'PRECONDITION_FAILED', path: e.path, expected: e.expected, actual: e.actual });
      return;
    }
    res.status(422).json({ error: 'undo_apply_failed', reason: (e as Error).message }); return;
  }

  // Persist: new version row, flip patch to rejected, restore any superseded.
  const versionInsert = await supa
    .from('variant_doc_versions')
    .insert({
      variant_id: patch.variant_id,
      doc: nextDoc,
      schema_fp: (patch as { schema_fp?: string }).schema_fp ?? '',
      patch_id: patch.id,
      prior_version_id: latestVersion?.id ?? null,
    })
    .select('id')
    .single();
  if (versionInsert.error || !versionInsert.data) {
    const code = (versionInsert.error as { code?: string } | null)?.code;
    if (code === '23505') {
      res.status(409).json({
        error: 'VERSION_FORK_DETECTED',
        message: 'variant has advanced since undo started — refresh and retry',
      });
      return;
    }
    res.status(500).json({ error: 'db_version_insert', detail: versionInsert.error?.message });
    return;
  }
  const versionId = versionInsert.data.id as string;

  await supa.from('patches').update({ status: 'rejected' }).eq('id', patch.id);

  // Restore any patches this one had superseded.
  const { data: restored } = await supa
    .from('patches')
    .select('id')
    .eq('superseded_by_id', patch.id);
  const restoredIds = ((restored ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (restoredIds.length > 0) {
    await supa
      .from('patches')
      .update({ superseded_by_id: null, status: 'applied' })
      .in('id', restoredIds);
  }

  await supa.from('variant_patches_audit').insert({
    variant_id: patch.variant_id,
    patch_id: patch.id,
    user_id: user.id,
    action: 'undone',
    detail: { restored_patch_ids: restoredIds },
  });

  // Return the post-undo doc so the client can canonical-replay against
  // :root rather than synthesizing inverse ops locally (which silently
  // no-ops on macro-only patches). See fix: undo-macro-revert-desync.
  res.status(200).json({
    version_id: versionId,
    restored_patch_ids: restoredIds,
    doc: nextDoc,
  });
}
