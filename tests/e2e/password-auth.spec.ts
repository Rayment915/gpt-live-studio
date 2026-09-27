import { expect, test } from '@playwright/test';

test.skip(process.env.PLAYWRIGHT_AUTH_MODE !== 'password', '仅在隔离的密码登录测试服务运行');

test('requires login before accessing the studio, API and session controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'GPT-Live Studio' })).toBeVisible();
  expect((await page.request.get('/api/config')).status()).toBe(401);
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('wrong');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
  expect((await page.request.get('/api/config')).status()).toBe(401);
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '对话，不必等待。' })).toBeVisible();
  const config = await (await page.request.get('/api/config')).json();
  expect(config.authMode).toBe('password');
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: 'GPT-Live Studio' })).toBeVisible();
  expect((await page.request.get('/api/config')).status()).toBe(401);
});
