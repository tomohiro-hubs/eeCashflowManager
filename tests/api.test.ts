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
  email = 'owner@example.com',
  opts?: { organizationId?: number; role?: 'owner' | 'admin' | 'editor' | 'viewer' | 'member'; isAdmin?: boolean }
): Promise<string> {
  const organizationId = opts?.organizationId ?? (await createOrganization());
  const inserted = await env.DB.prepare(
    'INSERT INTO users (organization_id, email, password_hash, password_salt, is_admin) VALUES (?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(organizationId, email, 'hash', 'salt', opts?.isAdmin ? 1 : 0)
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

async function createEntry(cookie: string, payload: {
  title: string;
  amount: number;
  type: 'income' | 'expense';
  scheduledDate: string;
  note?: string;
  labelColor?: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
}): Promise<void> {
  const res = await fetchApp('/api/entries', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie
    },
    body: JSON.stringify({ labelColor: 'blue', ...payload })
  });
  expect(res.status).toBe(200);
}

async function hashPassword(password: string, salt: string): Promise<string> {
  let state = new TextEncoder().encode(`${salt}:${password}`);
  for (let i = 0; i < 120_000; i += 1) {
    const digest = await crypto.subtle.digest('SHA-256', state);
    state = new Uint8Array(digest);
  }
  return [...state].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('auth gate', () => {
  it('rejects unauthenticated access to entries api', async () => {
    const res = await fetchApp('/api/entries?year=2026');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects unauthenticated access to summary api', async () => {
    const res = await fetchApp('/api/summary?month=2026-04');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('adds baseline security headers to responses', async () => {
    const res = await fetchApp('/login');

    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe('geolocation=(), microphone=(), camera=()');
  });

  it('blocks cross-site mutating request by CSRF guard', async () => {
    const cookie = await createAuthedCookie();
    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example',
        host: 'example.com',
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({
        title: 'CSRF attempt',
        amount: 1000,
        type: 'income',
        scheduledDate: '2026-04-10',
        labelColor: 'blue'
      })
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'CSRF validation failed' });
  });
});

describe('entries api', () => {
  it('creates and lists entries for authenticated user', async () => {
    const cookie = await createAuthedCookie();

    await createEntry(cookie, {
      title: 'Client payment',
      amount: 120000,
      type: 'income',
      scheduledDate: '2026-04-10',
      note: 'Invoice #A-42'
    });

    const listRes = await fetchApp('/api/entries?year=2026', {
      headers: { cookie }
    });

    expect(listRes.status).toBe(200);
    const payload = await listRes.json<{ entries: Array<{ title: string; amount: number; type: string }> }>();
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      title: 'Client payment',
      amount: 120000,
      type: 'income'
    });
  });

  it('shows entries across users in the same organization', async () => {
    const orgId = await createOrganization('shared-org');
    const cookieA = await createAuthedCookie('org-user-a@example.com', { organizationId: orgId, role: 'owner' });
    const cookieB = await createAuthedCookie('org-user-b@example.com', { organizationId: orgId, role: 'viewer' });

    await createEntry(cookieA, {
      title: 'Shared income',
      amount: 42000,
      type: 'income',
      scheduledDate: '2026-04-15'
    });

    const listRes = await fetchApp('/api/entries?year=2026', {
      headers: { cookie: cookieB }
    });
    expect(listRes.status).toBe(200);

    const payload = await listRes.json<{ entries: Array<{ title: string; amount: number; type: string }> }>();
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Shared income',
          amount: 42000,
          type: 'income'
        })
      ])
    );
  });

  it('keeps entries isolated across different organizations', async () => {
    const orgA = await createOrganization('org-a');
    const orgB = await createOrganization('org-b');
    const cookieA = await createAuthedCookie('org-a-user@example.com', { organizationId: orgA, role: 'owner' });
    const cookieB = await createAuthedCookie('org-b-user@example.com', { organizationId: orgB, role: 'owner' });

    await createEntry(cookieA, {
      title: 'Org A income',
      amount: 9900,
      type: 'income',
      scheduledDate: '2026-04-22'
    });

    const listRes = await fetchApp('/api/entries?year=2026', {
      headers: { cookie: cookieB }
    });
    expect(listRes.status).toBe(200);

    const payload = await listRes.json<{ entries: Array<{ title: string }> }>();
    expect(payload.entries.some((entry) => entry.title === 'Org A income')).toBe(false);
  });

  it('bulk updates selected entries (complete/date/actual-date)', async () => {
    const cookie = await createAuthedCookie();
    await createEntry(cookie, {
      title: 'Bulk A',
      amount: 1000,
      type: 'income',
      scheduledDate: '2026-04-10'
    });
    await createEntry(cookie, {
      title: 'Bulk B',
      amount: 1200,
      type: 'expense',
      scheduledDate: '2026-04-11'
    });

    const listed = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const listedPayload = await listed.json<{ entries: Array<{ id: number; title: string }> }>();
    const ids = listedPayload.entries
      .filter((e) => e.title === 'Bulk A' || e.title === 'Bulk B')
      .map((e) => e.id);
    expect(ids).toHaveLength(2);

    const completeRes = await fetchApp('/api/entries/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids, action: 'set_completed', isCompleted: true })
    });
    expect(completeRes.status).toBe(200);

    const dateRes = await fetchApp('/api/entries/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids, action: 'set_date', scheduledDate: '2026-05-20' })
    });
    expect(dateRes.status).toBe(200);

    const actualRes = await fetchApp('/api/entries/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids, action: 'set_actual_date', actualTransactionDate: '2026-05-21' })
    });
    expect(actualRes.status).toBe(200);

    const after = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const afterPayload = await after.json<{ entries: Array<{ id: number; scheduled_date: string; actual_transaction_date: string | null; is_completed: number }> }>();
    const updated = afterPayload.entries.filter((e) => ids.includes(e.id));
    expect(updated).toHaveLength(2);
    for (const row of updated) {
      expect(row.is_completed).toBe(1);
      expect(row.scheduled_date).toBe('2026-05-20');
      expect(row.actual_transaction_date).toBe('2026-05-21');
    }
  });

  it('lists completed annual entries for both income and expense', async () => {
    const cookie = await createAuthedCookie();
    await createEntry(cookie, {
      title: 'Annual Income',
      amount: 1000,
      type: 'income',
      scheduledDate: '2026-04-10'
    });
    await createEntry(cookie, {
      title: 'Annual Expense',
      amount: 700,
      type: 'expense',
      scheduledDate: '2026-04-11'
    });

    const listed = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const listedPayload = await listed.json<{ entries: Array<{ id: number; title: string }> }>();
    const ids = listedPayload.entries
      .filter((e) => e.title === 'Annual Income' || e.title === 'Annual Expense')
      .map((e) => e.id);
    expect(ids).toHaveLength(2);

    const completeRes = await fetchApp('/api/entries/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids, action: 'set_completed', isCompleted: true })
    });
    expect(completeRes.status).toBe(200);

    const annualRes = await fetchApp('/api/annual-expense-entries?year=2026', {
      headers: { cookie }
    });
    expect(annualRes.status).toBe(200);

    const annualPayload = await annualRes.json<{ entries: Array<{ title: string; type: 'income' | 'expense' }> }>();
    expect(annualPayload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Annual Income', type: 'income' }),
        expect.objectContaining({ title: 'Annual Expense', type: 'expense' })
      ])
    );
  });

  it('returns 400 for invalid create payload', async () => {
    const cookie = await createAuthedCookie();

    const res = await fetchApp('/api/entries', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie
      },
      body: JSON.stringify({
        title: 'Bad entry',
        amount: 10.5,
        type: 'income',
        scheduledDate: '2026-04-10'
      })
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid payload' });
  });

  it('returns 400 when reorder ids mismatch existing entries', async () => {
    const cookie = await createAuthedCookie();

    await createEntry(cookie, {
      title: 'A',
      amount: 100,
      type: 'income',
      scheduledDate: '2026-04-01'
    });

    const res = await fetchApp('/api/entries/reorder', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie
      },
      body: JSON.stringify({
        year: '2026',
        orderedIds: [999999]
      })
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'IDs mismatch' });
  });

  it('deletes an existing entry and returns 404 for unknown id', async () => {
    const cookie = await createAuthedCookie();

    await createEntry(cookie, {
      title: 'Delete target',
      amount: 5000,
      type: 'expense',
      scheduledDate: '2026-04-12'
    });

    const listBefore = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const beforePayload = await listBefore.json<{ entries: Array<{ id: number }> }>();
    const id = beforePayload.entries[0]?.id;
    expect(id).toBeTypeOf('number');

    const deleteOk = await fetchApp(`/api/entries/${id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(deleteOk.status).toBe(200);
    await expect(deleteOk.json()).resolves.toEqual({ ok: true });

    const deleteMissing = await fetchApp('/api/entries/999999', {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(deleteMissing.status).toBe(404);
    await expect(deleteMissing.json()).resolves.toEqual({ error: 'Entry not found' });
  });

  it('updates entry date and moves entry to the destination month list', async () => {
    const cookie = await createAuthedCookie();

    await createEntry(cookie, {
      title: 'Move target',
      amount: 7000,
      type: 'expense',
      scheduledDate: '2026-04-12'
    });

    const listBefore = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const beforePayload = await listBefore.json<{ entries: Array<{ id: number }> }>();
    const id = beforePayload.entries[0]?.id;
    expect(id).toBeTypeOf('number');

    const updateRes = await fetchApp(`/api/entries/${id}/date`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie
      },
      body: JSON.stringify({ scheduledDate: '2026-05-03' })
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toEqual({ ok: true });

    const listRes = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const payload = await listRes.json<{ entries: Array<{ id: number; scheduled_date: string }> }>();
    const moved = payload.entries.find((entry) => entry.id === id);
    expect(moved).toMatchObject({ id, scheduled_date: '2026-05-03' });
  });

  it('excludes soft-deleted entries from entries and summary totals', async () => {
    const cookie = await createAuthedCookie();

    await createEntry(cookie, {
      title: 'Income keep',
      amount: 1000,
      type: 'income',
      scheduledDate: '2026-04-02'
    });
    await createEntry(cookie, {
      title: 'Expense delete',
      amount: 300,
      type: 'expense',
      scheduledDate: '2026-04-03'
    });

    const listBefore = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const beforePayload = await listBefore.json<{ entries: Array<{ id: number; title: string }> }>();
    const target = beforePayload.entries.find((e) => e.title === 'Expense delete');
    expect(target?.id).toBeTypeOf('number');

    const del = await fetchApp(`/api/entries/${target?.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(del.status).toBe(200);

    const listAfter = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const afterPayload = await listAfter.json<{ entries: Array<{ title: string }> }>();
    expect(afterPayload.entries).toHaveLength(1);
    expect(afterPayload.entries[0]?.title).toBe('Income keep');

    const summary = await fetchApp('/api/summary?month=2026-04', { headers: { cookie } });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toEqual({
      month: '2026-04',
      income: 1000,
      expense: 0,
      balance: 1000
    });
  });
});

describe('audits api', () => {
  it('rejects unauthenticated access', async () => {
    const res = await fetchApp('/api/audits?month=2026-04&limit=10');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 for invalid limit', async () => {
    const cookie = await createAuthedCookie();

    const res = await fetchApp('/api/audits?month=2026-04&limit=0', {
      headers: { cookie }
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid limit. Use 1..500.' });
  });
});

describe('password reset', () => {
  it('returns 403 for JSON password-reset endpoints while reset is disabled', async () => {
    const forgot = await fetchApp('/api/auth/forgot-password', { method: 'POST' });
    expect(forgot.status).toBe(403);
    await expect(forgot.json()).resolves.toEqual({ error: 'Password reset is disabled' });

    const reset = await fetchApp('/api/auth/reset-password', { method: 'POST' });
    expect(reset.status).toBe(403);
    await expect(reset.json()).resolves.toEqual({ error: 'Password reset is disabled' });
  });

  it('returns 403 for form password-reset endpoints while reset is disabled', async () => {
    const forgot = await fetchApp('/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'disabled@example.com' })
    });
    expect(forgot.status).toBe(403);

    const reset = await fetchApp('/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'a'.repeat(64), password: 'Strong#Pass123' })
    });
    expect(reset.status).toBe(403);
  });
});

describe('session cookie security', () => {
  it('issues session cookie with secure, httponly and samesite=strict', async () => {
    const email = 'cookie-sec@example.com';
    const password = 'Correct#Pass123';
    const salt = 'salt-cookie';
    const hash = await hashPassword(password, salt);
    await env.DB.prepare('INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)')
      .bind(email, hash, salt)
      .run();

    const res = await fetchApp('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password })
    });

    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
  });
});

describe('audit logs api', () => {
  it('filters session logs by JST day boundaries', async () => {
    const cookie = await createAuthedCookie('audit-admin@example.com', { isAdmin: true, role: 'owner' });
    const userRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('audit-admin@example.com')
      .first<{ id: number }>();
    expect(userRow?.id).toBeTruthy();

    await env.DB.prepare(
      `INSERT INTO user_session_logs (user_id, session_token, login_at)
       VALUES (?, 'tokyo-in', '2026-06-18 15:30:00'),
              (?, 'tokyo-out', '2026-06-19 15:30:00')`
    )
      .bind(userRow!.id, userRow!.id)
      .run();

    const res = await fetchApp('/api/audit/session-logs?from=2026-06-19&to=2026-06-19', {
      headers: { cookie }
    });

    expect(res.status).toBe(200);
    const payload = await res.json<{ logs: Array<{ session_token_masked: string }> }>();
    expect(payload.logs).toHaveLength(1);
    expect(payload.logs[0].session_token_masked).toContain('tokyo-in');
  });
});

describe('rakuraku csv import errors', () => {
  it('returns error code when multipart file is missing', async () => {
    const cookie = await createAuthedCookie('csv-missing@example.com');
    const formData = new FormData();
    formData.append('syncEntries', 'true');
    const res = await fetchApp('/api/import/rakuraku', {
      method: 'POST',
      headers: { cookie },
      body: formData
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'CSV_IMPORT_FILE_MISSING'
    });
  });

  it('returns error code when csv header is invalid', async () => {
    const cookie = await createAuthedCookie('csv-header@example.com');
    const csv = ['foo,bar,baz', '1,2,3'].join('\n');
    const formData = new FormData();
    formData.append('file', new File([csv], 'invalid.csv', { type: 'text/csv' }));
    formData.append('syncEntries', 'true');
    const res = await fetchApp('/api/import/rakuraku', {
      method: 'POST',
      headers: { cookie },
      body: formData
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'CSV_IMPORT_HEADER_MISMATCH'
    });
  });

  it('returns error code when content type is unsupported', async () => {
    const cookie = await createAuthedCookie('csv-content-type@example.com');
    const res = await fetchApp('/api/import/rakuraku', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'text/plain'
      },
      body: 'not supported'
    });

    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'CSV_IMPORT_UNSUPPORTED_CONTENT_TYPE'
    });
  });

  it('updates existing entries by managementNo on re-import', async () => {
    const cookie = await createAuthedCookie('csv-upsert@example.com');
    const row1 = {
      managementNo: 'M-100',
      projectName: '初回案件',
      expenseTotalInclTax: 1000,
      incomeTotalInclTax: 2000,
      customerName: '顧客A',
      scheduledDate: '2026-04-10'
    };
    const row2 = {
      managementNo: 'M-100',
      projectName: '更新案件',
      expenseTotalInclTax: 3000,
      incomeTotalInclTax: 4000,
      customerName: '顧客B',
      scheduledDate: '2026-05-20'
    };

    const importCsv = async (rows: unknown[]) => {
      return fetchApp('/api/import/rakuraku', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceFileName: 'upsert.json', syncEntries: true, rows })
      });
    };

    const first = await importCsv([row1]);
    expect(first.status).toBe(200);
    const list1 = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const payload1 = await list1.json<{ entries: Array<{ title: string; amount: number }> }>();
    const firstRows = payload1.entries.filter((e) => e.title === '初回案件');
    expect(firstRows).toHaveLength(2);
    expect(firstRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: 2000 }),
        expect.objectContaining({ amount: 1000 })
      ])
    );

    const second = await importCsv([row2]);
    expect(second.status).toBe(200);
    const list2 = await fetchApp('/api/entries?year=2026', { headers: { cookie } });
    const payload2 = await list2.json<{ entries: Array<{ title: string; amount: number; scheduled_date: string; customer_name: string | null }> }>();
    const secondRows = payload2.entries.filter((e) => e.title === '更新案件');
    expect(secondRows).toHaveLength(2);
    expect(secondRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '更新案件', amount: 4000, scheduled_date: '2026-05-20', customer_name: '顧客B' }),
        expect.objectContaining({ title: '更新案件', amount: 3000, scheduled_date: '2026-05-20', customer_name: '顧客B' })
      ])
    );
  });

});
