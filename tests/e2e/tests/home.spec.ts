import { test, expect } from '@playwright/test';

test('home page advertises the game and shows downloads', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/clowns.*mimes/i);
  await expect(page.getByRole('link', { name: /Windows/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /macOS/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Linux/ })).toBeVisible();
});

test('how to play section is reachable on mobile', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /how to play/i })).toBeVisible();
});

test('all four topology cards render', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /^Plane/, level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Torus/, level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Klein bottle/, level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Double torus/, level: 3 })).toBeVisible();
});
