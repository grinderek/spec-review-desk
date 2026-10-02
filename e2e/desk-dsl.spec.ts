import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

test('review a YAML contract, preserve formatting approval, and show changed expectations', async ({ page }) => {
  await page.goto('/?t=e2e')
  await page.getByRole('button', { name: /add-dsl-review/ }).click()
  const card = page.locator('article.scn', { hasText: 'Review a YAML contract' })
  await card.getByRole('button', { name: /Review a YAML contract/ }).click()
  await expect(card.locator('[data-desk-contract]')).toContainText('when:')
  await expect(card.locator('[data-shape-line]')).toHaveText(/Given\s*ScenarioDiscovered\s*When\s*ApproveScenario\s*Then\s*ScenarioApproved/)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(card.locator('.pill.p-approved')).toBeVisible()
  const wt = page.url().split('#/')[1]!.split('/')[0]!
  const view = await page.evaluate(async (id) => (await fetch(`/api/changes/${id}/add-dsl-review`)).json(), wt)
  const source = path.join(view.dir, 'features/review.desk.yaml')
  // The web server creates this disposable repository; never operate on a configured real repo.
  expect(source).toMatch(/^\/tmp\/sr-hub-/)
  const before = await readFile(source, 'utf8')
  try {
    await writeFile(source, '# Formatting change\n' + before)
    await page.reload()
    await expect(card.locator('.pill.p-approved')).toBeVisible()
    await writeFile(source, before.replace('status: 200', 'status: 201'))
    await expect(card.locator('.pill.p-pending')).toHaveText('pending · changed')
    await card.getByRole('button', { name: /Review a YAML contract/ }).click()
    await expect(card.locator('[data-desk-contract]')).toContainText('status: 201')
    await card.getByRole('button', { name: 'Show changes' }).click()
    await expect(card.locator('.diffview')).toContainText('status: 201')
  } finally { await writeFile(source, before) }
})
