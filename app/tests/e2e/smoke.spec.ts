import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installBackendMocks, installElectronApiMock } from './support/mockTruss';

async function expectNoAxeHighImpactViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    // Truss themes are user-extensible; contrast tuning should be audited separately.
    .disableRules(['color-contrast'])
    .analyze();

  const highImpact = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (highImpact.length > 0) {
    const summary = highImpact.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`).join('\n');
    throw new Error(`Axe high-impact violations in ${label}:\n${summary}`);
  }
}

test('launches into setup wizard and validates password length', async ({ page }) => {
  await installElectronApiMock(page);
  await installBackendMocks(page, 'uninitialized');

  await page.goto('/');

  await expect(page.getByText('Welcome to Truss')).toBeVisible();
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByText('Configure Encryption')).toBeVisible();
  await page.getByRole('button', { name: 'Initialize Store' }).click();
  await expect(page.getByText('Password must be at least 8 characters.')).toBeVisible();
});

test('opens a mocked context, selects a pod, and reaches the YAML tab', async ({ page }) => {
  await installElectronApiMock(page);
  await installBackendMocks(page, 'ready');

  await page.goto('/');

  await expect(page.getByText('Truss')).toBeVisible();
  await expect(page.getByLabel('Active Kubernetes context')).toHaveValue('dev-cluster');

  await page.locator('.kind-item', { hasText: 'Pod' }).first().click();
  await expect(page.getByText('demo-pod', { exact: true })).toBeVisible();

  await page.getByText('demo-pod', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Yaml', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yaml', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Edit YAML' })).toBeVisible();
});

test('axe smoke: setup wizard and main shell have no high-impact a11y violations', async ({ page }) => {
  await installElectronApiMock(page);
  await installBackendMocks(page, 'uninitialized');

  await page.goto('/');
  await expect(page.getByText('Welcome to Truss')).toBeVisible();
  await expectNoAxeHighImpactViolations(page, 'setup wizard');

  await installBackendMocks(page, 'ready');
  await page.reload();
  await expect(page.getByText('Truss')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open vault and context manager' })).toBeVisible();
  await expectNoAxeHighImpactViolations(page, 'main shell');
});
