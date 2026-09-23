import { expect, test } from '@playwright/test'

test('review, question, patch, re-approval and approval record', async ({ page }) => {
  await page.goto('/?t=e2e')
  await page.getByRole('button', { name: /add-thread-state/ }).click()

  const outline = page.locator('article.scn', { hasText: 'A waiting thread is weighted by its age' })
  await outline.getByRole('button', { name: /A waiting thread is weighted by its age/ }).click()
  await outline.getByRole('button', { name: 'Approve' }).click()
  await expect(outline.locator('.pill.p-approved')).toBeVisible()

  await outline.getByRole('button', { name: 'Ask the agent' }).click()
  await page.getByLabel('Question').fill('Why business hours?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Rows weigh by business-hour age, not calendar age.')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Apply & commit' }).click()
  await expect(page.getByText(/Applied · [0-9a-f]{7}/)).toBeVisible()
  await expect(outline.getByText('Changed since approval.')).toBeVisible()
  await outline.getByRole('button', { name: 'Show changes' }).click()
  await expect(outline.locator('.diffview .add', { hasText: 'rows weigh by business-hour age' })).toBeVisible()
  await outline.getByRole('button', { name: 'Approve' }).click()
  await expect(outline.locator('.pill.p-approved')).toBeVisible()

  const plain = page.locator('article.scn', { hasText: "The founder's reply resolves a waiting thread" })
  await plain.getByRole('button', { name: /The founder's reply resolves a waiting thread/ }).click()
  await plain.getByRole('button', { name: 'Approve' }).click()
  await expect(plain.locator('.pill.p-approved')).toBeVisible()

  await page.getByRole('tab', { name: /New phrases/ }).click()
  for (const remaining of [3, 2, 1]) {
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(remaining)
    await page.getByRole('button', { name: 'Approve' }).first().click()
  }
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Resolve' }).click()
  await page.getByRole('button', { name: 'Record approval' }).click()
  await expect(page.locator('.ready.on', { hasText: /^approved 20\d\d-\d\d-\d\d$/ })).toBeVisible()
})
