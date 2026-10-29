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

  await expect(page.locator('.patch .p-stale')).toBeVisible()
  await page.getByRole('button', { name: 'Обновить патч', exact: true }).click()
  await expect(page.getByText('The correction has been rebuilt against the current files.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.patch .p-proposed')).toBeVisible()

  await page.getByRole('button', { name: 'Apply & commit' }).click()
  await expect(page.getByText(/Applied · [0-9a-f]{7}/)).toBeVisible()
  await expect(outline.getByText('Changed since approval.')).toBeVisible()
  await outline.getByRole('button', { name: 'Show changes' }).click()
  await expect(outline.locator('.diffview .add', { hasText: 'rows weigh by business-hour age' })).toBeVisible()
  await outline.getByRole('button', { name: 'Approve' }).click()
  await expect(outline.locator('.pill.p-approved')).toBeVisible()

  const plain = page.locator('article.scn', { hasText: "The founder's reply resolves a waiting thread" })
  await plain.getByRole('button', { name: /The founder's reply resolves a waiting thread/ }).click()
  // The scenario as an event-sourcing spec, from the catalogs' Event / Command column; it keeps
  // the shape (one When, Then after it), so no off-shape pill.
  await expect(plain.locator('[data-shape-line]')).toHaveText(/Given\s*FounderRegistered\s*MailboxSynced\s*When\s*SyncGmail\s*Then/)
  await expect(plain.locator('.pill.p-warn')).toHaveCount(0)
  await plain.getByRole('button', { name: 'Approve' }).click()
  await expect(plain.locator('.pill.p-approved')).toBeVisible()

  await plain.getByRole('button', { name: 'Ask the agent' }).click()
  await page.getByLabel('Question').fill('Explain the founder reply.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('The founder reply is a separate discussion.', { exact: true })).toBeVisible({ timeout: 20_000 })
  const openThreads = page.getByRole('navigation', { name: 'Открытые обсуждения' })
  await expect(openThreads.getByRole('button')).toHaveCount(2)
  await expect(openThreads.getByRole('button', { name: /A waiting thread is weighted by its age/ })).toBeInViewport({ ratio: 1 })
  await expect(openThreads.getByRole('button', { name: /The founder's reply resolves a waiting thread/ })).toBeInViewport({ ratio: 1 })
  await openThreads.getByRole('button', { name: /A waiting thread is weighted by its age/ }).click()
  await page.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(openThreads.getByRole('button')).toHaveCount(1)
  await expect(openThreads.getByRole('button', { name: /A waiting thread/ })).toHaveCount(0)
  await expect(page.locator('.thread-history')).not.toHaveAttribute('open')
  await openThreads.getByRole('button', { name: /The founder's reply resolves a waiting thread/ }).click()
  await expect(page.getByText('The founder reply is a separate discussion.', { exact: true })).toBeVisible()
  await expect(openThreads.getByRole('button')).toHaveCount(1)

  await page.getByRole('tab', { name: /Шаблоны шагов/ }).click()
  await expect(page.getByRole('columnheader', { name: 'Event / Command' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'MailboxSynced' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0)
  await expect(page.getByText('Выражение корректно', { exact: true })).toHaveCount(3)

  await page.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Открытые обсуждения' })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Thread' }).getByText('Select a scenario and ask a question, or open a thread.', { exact: true })).toBeVisible()
  await expect(page.locator('.thread-history')).not.toHaveAttribute('open')
  await page.getByRole('button', { name: 'Record approval' }).click()
  await expect(page.locator('.ready.on', { hasText: /^approved 20\d\d-\d\d-\d\d$/ })).toBeVisible()
})
