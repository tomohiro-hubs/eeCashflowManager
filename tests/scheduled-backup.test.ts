import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';

// 定期バックアップ（wrangler.jsonc の cron）は、Workers が default export の scheduled を呼んで動く。
// 2026-10-27 まで default export が Hono の app だけで、scheduled が一度も呼ばれていなかった。

async function createOrgWithEntry(): Promise<number> {
  const org = await env.DB.prepare('INSERT INTO organizations (name) VALUES (?) RETURNING id')
    .bind(`org-${crypto.randomUUID()}`)
    .first<{ id: number }>();
  if (!org?.id) throw new Error('Failed to create organization');
  const user = await env.DB.prepare(
    'INSERT INTO users (organization_id, email, password_hash, password_salt, is_admin) VALUES (?, ?, ?, ?, 0) RETURNING id'
  )
    .bind(org.id, `${crypto.randomUUID()}@example.com`, 'hash', 'salt')
    .first<{ id: number }>();
  if (!user?.id) throw new Error('Failed to create user');
  await env.DB.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .bind(org.id, user.id, 'member')
    .run();
  const token = crypto.randomUUID().replaceAll('-', '');
  await env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, token, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
    .run();

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request('http://example.com/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `cf_cashflow_session=${token}` },
      body: JSON.stringify({ title: '架空の入金', amount: 1000, type: 'income', scheduledDate: '2026-11-10', labelColor: 'blue' }),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return org.id;
}

describe('scheduled backup', () => {
  it('exports scheduled on the default export so the cron trigger reaches it', () => {
    expect(typeof worker.scheduled).toBe('function');
    expect(typeof worker.fetch).toBe('function');
  });

  it('creates a scheduled backup for an organization that has entries', async () => {
    const orgId = await createOrgWithEntry();
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: '59 14 * * *', scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare(
      "SELECT source, entry_count FROM cashflow_entry_backups WHERE organization_id = ? AND source = 'scheduled'"
    )
      .bind(orgId)
      .first<{ source: string; entry_count: number }>();
    expect(row).toEqual({ source: 'scheduled', entry_count: 1 });
  });
});
