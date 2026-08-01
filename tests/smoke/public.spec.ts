import { expect, test } from '@playwright/test';

test.describe('public launch smoke', () => {
  test('homepage loads with services grid', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.ok()).toBeTruthy();
    await expect(page.locator('body')).toBeVisible();
    // CMS-injected services use data-cal-link on bookable rows.
    const calLinks = page.locator('[data-cal-link]');
    await expect(calLinks.first()).toBeVisible({ timeout: 30_000 });
    expect(await calLinks.count()).toBeGreaterThan(0);
  });

  test('reviews API responds', async ({ request }) => {
    const res = await request.get('/api/reviews');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('unsigned Cal webhook is rejected', async ({ request }) => {
    const res = await request.post('/api/webhook', {
      data: { triggerEvent: 'BOOKING_CREATED', payload: { uid: 'smoke-test' } },
      headers: { 'content-type': 'application/json' },
    });
    // 401 = bad/missing signature; 503 = secret not configured yet.
    expect([401, 503]).toContain(res.status());
  });
});
