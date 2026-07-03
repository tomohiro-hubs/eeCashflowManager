import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import app from '../src';

async function fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`http://example.com${path}`, init);
  const ctx = createExecutionContext();
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createOrganization(name = `org-${crypto.randomUUID()}`): Promise<number> {
  const inserted = await env.DB.prepare('INSERT INTO organizations (name) VALUES (?) RETURNING id')
    .bind(name)
    .first<{ id: number }>();
  if (!inserted?.id) throw new Error('Failed to create organization');
  return inserted.id;
}

async function createAuthedCookie(
  email?: string,
  opts?: { organizationId?: number; role?: 'owner' | 'admin' | 'editor' | 'viewer' | 'member'; isAdmin?: boolean }
): Promise<string> {
  const finalEmail = email ?? `test-${crypto.randomUUID()}@example.com`;
  const organizationId = opts?.organizationId ?? (await createOrganization());
  const inserted = await env.DB.prepare(
    'INSERT INTO users (organization_id, email, password_hash, password_salt, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(organizationId, finalEmail, 'hash', 'salt', opts?.isAdmin ? 1 : 0)
    .first<{ id: number }>();

  const userId = inserted?.id;
  if (!userId) throw new Error('Failed to create user');

  await env.DB.prepare(
    'INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)'
  )
    .bind(organizationId, userId, opts?.role ?? 'member')
    .run();

  const token = crypto.randomUUID().replaceAll('-', '');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(userId, token, expiresAt)
    .run();

  return `cf_cashflow_session=${token}`;
}

// Simulate what the frontend actually sends
describe('Frontend payload simulation', () => {

  // Simulate: User types "50000", blurs -> input.value becomes "50,000"
  // Frontend sends: amount: Number("50000" || 0) = 50000
  it('amount=50000 (number) should work', async () => {
    const cookie = await createAuthedCookie(undefined, { role: 'editor' });
    const payload = {
      title: 'テスト1',
      content: '',
      amount: 50000,
      amountDigits: '50000',
      type: 'income',
      scheduledDate: '2026-07-15',
      note: '',
      accountName: '',
      customerName: '',
      staffName: '',
      labelColor: 'blue',
      cfCategory: ''
    };
    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    console.log('Test 1 - amount=50000:', res.status, JSON.stringify(body));
    expect(res.status).toBe(200);
  });

  // What if frontend sends amount as string (like "50,000" from formatted input)?
  // JSON.stringify({ amount: "50,000" }) -> {"amount":"50,000"}
  // Backend parseJsonBody would get amount as string "50,000"
  // parseNormalizedAmount("50,000") -> String("50,000") -> "50,000" -> digits "50000" -> OK
  it('amount="50,000" (string with comma) should work', async () => {
    const cookie = await createAuthedCookie(undefined, { role: 'editor' });
    const payload = {
      title: 'テスト2',
      content: '',
      amount: "50,000",
      amountDigits: '50000',
      type: 'income',
      scheduledDate: '2026-07-15',
      note: '',
      accountName: '',
      customerName: '',
      staffName: '',
      labelColor: 'blue',
      cfCategory: ''
    };
    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    console.log('Test 2 - amount="50,000":', res.status, JSON.stringify(body));
    // This should also work since parseNormalizedAmount handles String conversion
    expect(res.status).toBe(200);
  });

  // What if somehow the formatted value gets passed to Number() directly?
  // Number("50,000") = NaN
  // parseNormalizedAmount(NaN) -> String(NaN) -> "NaN" -> digits "" (after removing non-digits) -> /^[1-9]\d*$/ fails -> null
  it('amount=NaN should fail', async () => {
    const cookie = await createAuthedCookie(undefined, { role: 'editor' });
    const payload = {
      title: 'テスト3',
      content: '',
      amount: NaN,
      amountDigits: '',
      type: 'income',
      scheduledDate: '2026-07-15',
      note: '',
      accountName: '',
      customerName: '',
      staffName: '',
      labelColor: 'blue',
      cfCategory: ''
    };
    // JSON.stringify converts NaN to null
    const jsonStr = JSON.stringify(payload);
    console.log('Test 3 - JSON payload:', jsonStr);
    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: jsonStr
    });
    const body = await res.json();
    console.log('Test 3 - amount=NaN:', res.status, JSON.stringify(body));
    expect(res.status).toBe(400);
  });

  // Replicate exact frontend flow:
  // 1. User types "50000" in input
  // 2. blur -> syncAmountInputDisplay -> input.value = "50,000"
  // 3. Submit handler reads input.value = "50,000"
  // 4. parseAmountInputState("50,000") -> normalizeAmountInputValue("50,000") -> "50000"
  //    -> { digits: "50000", amount: 50000 }
  // 5. payload.amount = Number("50000" || 0) = 50000
  // This all works fine.

  // But what if the user types "50,000" directly (with comma)?
  // parseAmountInputState("50,000") -> normalizeAmountInputValue("50,000") -> "50000"
  // -> { digits: "50000", amount: 50000 }
  // payload.amount = Number("50000" || 0) = 50000
  // This also works fine.

  // What about empty string?
  // normalizeAmountInputValue("") -> "" -> digits = ""
  // parseAmountInputState("") -> { digits: "", amount: 0 }
  // payload.amount = Number("" || 0) = Number(0) = 0
  // Backend: parseNormalizedAmount(0) -> String(0) -> "0" -> /^[1-9]\d*$/.test("0") = false -> null
  // This correctly fails.

  // Let's test a very specific edge case: what if the JSON body includes
  // additional fields that might confuse the parser?
  it('payload with extra amountDigits field', async () => {
    const cookie = await createAuthedCookie(undefined, { role: 'editor' });
    // Exact payload structure sent by frontend
    const payload = {
      title: 'テスト4',
      content: '',
      amount: 120000,
      amountDigits: '120000',
      type: 'expense',
      scheduledDate: '2026-07-15',
      note: '',
      accountName: '',
      customerName: '',
      staffName: '',
      labelColor: 'red',
      cfCategory: ''
    };
    console.log('Test 4 - exact frontend payload:', JSON.stringify(payload));
    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    console.log('Test 4 - result:', res.status, JSON.stringify(body));
    expect(res.status).toBe(200);
  });
});
