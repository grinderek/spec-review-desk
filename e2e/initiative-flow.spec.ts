import { expect, test } from '@playwright/test'

test('New feature → plan → approve → propose s1 → the change appears', async ({ page }) => {
  await page.goto('/?t=e2e')
  await page.getByRole('button', { name: '+ New feature' }).click()
  await page.getByLabel('Name', { exact: true }).fill('health-score')
  await page.getByLabel('Title', { exact: true }).fill('Business health score')
  await page.getByLabel('Brief', { exact: true }).fill('Score the founder day.')
  await expect(page.getByLabel('Create will run')).toContainText('worktree add .codex/worktrees/health-score -b plan/health-score initiative-base')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: /health-score/ })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Plan slices' }).click()
  await expect(page.getByLabel('Title of slice 1')).toHaveValue('Engine', { timeout: 20_000 })
  await page.getByLabel('Scope of slice 2').fill('Delivery states, edited by the owner.')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  await page.getByRole('button', { name: 'Approve plan' }).click()

  const s1 = page.locator('[data-slice="s1"]')
  await expect(s1).toContainText('planned')
  await expect(page.locator('[data-slice="s2"]')).toContainText('Delivery states, edited by the owner.')
  await expect(page.locator('[data-slice="s2"]')).toContainText('waiting for s1')
  // The first attempt hangs (the fixture's fake author hangs once on the 'Slice s1' prompt) so the
  // Plan tab's Stop control can be exercised, then the slice must become proposable again.
  await s1.getByLabel('Notes for s1').fill('Keep it small.')
  await s1.getByRole('button', { name: 'Propose s1' }).click()
  await expect(s1.locator('.pill')).toHaveText('proposing', { timeout: 20_000 })
  await expect(s1.getByRole('button', { name: 'Stop' })).toBeVisible()
  await s1.getByRole('button', { name: 'Stop' }).click()
  await expect(s1.locator('.pill')).toHaveText('planned', { timeout: 20_000 })
  await expect(s1.getByRole('button', { name: 'Propose s1' })).toBeVisible()

  // Propose s1 again — the hang-once budget is spent, so this attempt finishes for real.
  await s1.getByLabel('Notes for s1').fill('Keep it small.')
  await s1.getByRole('button', { name: 'Propose s1' }).click()
  await expect(s1.locator('.pill')).toHaveText('proposed', { timeout: 20_000 })
  await expect(s1.getByRole('link', { name: 'add-health-score-engine' })).toBeVisible()
  await expect(page.locator('.itag', { hasText: 'health-score · s1' })).toBeVisible()

  await page.getByRole('tab', { name: /Runs/ }).click()
  await expect(page.locator('[data-run]').first()).toContainText('author · s1')
})
