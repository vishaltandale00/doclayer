/**
 * Smoke tests for POST /api/comments/post.
 *
 * Endpoint was added in the Neon refactor; these tests cover the four key
 * branches: happy path, missing auth (401), rate-limit (429), and a 422
 * validation case. DB + auth are mocked via `mock.module` so the suite stays
 * deterministic and offline.
 *
 * Requires the runner flag `--experimental-test-module-mocks` (added in
 * Node 22.3+). See package.json `test:api` script.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---- Module mocks ----
// We install these BEFORE importing the handler so the handler picks them up.
let sqlOneCalls: Array<{ text: string; params: unknown[] }> = [];
let sqlOneImpl: (text: string, params: unknown[]) => Promise<unknown> =
  async () => ({ id: 'comment-test-1' });

// The Bearer token doubles as the synthetic user_id so individual tests can
// pick a fresh user to dodge cross-test state in the rate-limit bucket.
mock.module('../../lib/auth.ts', {
  namedExports: {
    requireAuth: async (req: any) => {
      const header = req?.headers?.authorization;
      if (!header || !String(header).startsWith('Bearer ')) {
        return { error: 'missing_authorization', status: 401 };
      }
      const token = String(header).slice('Bearer '.length).trim();
      const userId = token || 'test-user-1';
      return {
        user_id: userId,
        email: `${userId}@example.com`,
        email_handle: userId,
        variant_id: `variant-${userId}`,
      };
    },
  },
});

mock.module('../../lib/db.ts', {
  namedExports: {
    sql: async () => [],
    sqlOne: async (text: string, params: unknown[]) => {
      sqlOneCalls.push({ text, params });
      return sqlOneImpl(text, params);
    },
    tx: async (fn: (client: any) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [] }) }),
  },
});

// Dynamic import so the mocks above are in place first.
const { default: handler } = await import('../comments/post.ts');

// ---- Tiny req/res fakes ----
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
}
function makeRes(): FakeRes & {
  status: (n: number) => any;
  json: (v: unknown) => any;
  setHeader: (k: string, v: string) => void;
  end: () => void;
} {
  const out: FakeRes = { statusCode: 0, headers: {}, body: undefined, ended: false };
  const res: any = out;
  res.status = (n: number) => { out.statusCode = n; return res; };
  res.json = (v: unknown) => { out.body = v; out.ended = true; return res; };
  res.setHeader = (k: string, v: string) => { out.headers[k.toLowerCase()] = v; };
  res.end = () => { out.ended = true; };
  return res;
}
function makeReq(opts: {
  method?: string;
  auth?: string | null;
  body?: unknown;
}): any {
  const headers: Record<string, string> = {};
  if (opts.auth !== null && opts.auth !== undefined) headers.authorization = opts.auth;
  return {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body,
  };
}

// Reset mock state between tests (the in-memory rate bucket is module-level
// inside post.ts; we work around it by using a different user_id per case
// or by exhausting deliberately).
function resetCalls() { sqlOneCalls = []; }

// ---- Tests ----
test('comments/post happy path → 200 + comment_id', async () => {
  resetCalls();
  sqlOneImpl = async () => ({ id: 'cmt-happy-1' });
  const req = makeReq({
    auth: 'Bearer test-user-1',
    body: { scenario: 'tour-onboarding', feedback: 'this is great feedback', phase: 'intro' },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  const body = res.body as any;
  assert.equal(body.ok, true);
  assert.equal(body.comment_id, 'cmt-happy-1');
  assert.equal(sqlOneCalls.length, 1);
  // Params: user_id, variant_id, scenario, phase, anchor-json, feedback
  const params = sqlOneCalls[0].params;
  assert.equal(params[0], 'test-user-1');
  assert.equal(params[1], 'variant-test-user-1');
  assert.equal(params[2], 'tour-onboarding');
  assert.equal(params[3], 'intro');
  assert.equal(params[5], 'this is great feedback');
});

test('comments/post missing Authorization → 401', async () => {
  resetCalls();
  const req = makeReq({
    auth: null,
    body: { scenario: 'tour-onboarding', feedback: 'hello world' },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal((res.body as any).error, 'missing_authorization');
  assert.equal(sqlOneCalls.length, 0);
});

test('comments/post invalid_scenario → 422', async () => {
  resetCalls();
  const req = makeReq({
    auth: 'Bearer test-jwt',
    // Capital letters violate kebab-case regex.
    body: { scenario: 'Tour_Onboarding!', feedback: 'hello world' },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal((res.body as any).error, 'invalid_scenario');
  assert.equal(sqlOneCalls.length, 0);
});

test('comments/post rate limit → 429 after RATE_LIMIT requests', async () => {
  resetCalls();
  sqlOneImpl = async () => ({ id: 'cmt-rl' });
  // Use a per-test unique token so we get a fresh rate bucket. The auth mock
  // maps token → user_id, and post.ts buckets per user_id.
  const token = `rl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const authHeader = `Bearer ${token}`;
  // RATE_LIMIT = 10 in api/comments/post.ts.
  for (let i = 0; i < 10; i++) {
    const res = makeRes();
    await handler(makeReq({ auth: authHeader, body: { scenario: 'rl-test', feedback: 'okay okay' } }), res);
    assert.equal(res.statusCode, 200, `iteration ${i} expected 200, got ${res.statusCode}`);
  }
  // 11th request should be rate-limited.
  const res = makeRes();
  await handler(makeReq({ auth: authHeader, body: { scenario: 'rl-test', feedback: 'okay okay' } }), res);
  assert.equal(res.statusCode, 429);
  assert.equal((res.body as any).error, 'rate_limit');
  assert.ok(res.headers['retry-after'], 'Retry-After header should be set');
});
