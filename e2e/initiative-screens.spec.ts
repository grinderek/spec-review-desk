import { expect, test } from '@playwright/test'
import { newInitiative } from './helpers.ts'

// Desk fixes item 2: the brief is edited on the Brief tab (Edit / Save / Cancel) and committed.
test('the brief is edited on the Brief tab, saved and committed; Cancel discards', async ({ page }) => {
  const id = await newInitiative(page, 'brief-edit')
  await page.getByRole('tab', { name: 'Brief' }).click()
  await page.getByRole('button', { name: 'Edit brief' }).click()
  const editor = page.getByLabel('Brief text')
  const text = ['# What', '', 'The **edited** brief.', '', ...Array.from({ length: 14 }, (_, i) => `- point ${i + 1}`)].join('\n')
  await editor.fill(text)
  // The editor grows with its text: every line is visible without scrolling inside it.
  expect(await editor.evaluate((el) => el.scrollHeight <= el.clientHeight + 4)).toBe(true)
  await page.getByRole('button', { name: 'Save brief' }).click()
  const shown = page.getByLabel('brief.md')
  await expect(shown.locator('strong')).toHaveText('edited')
  await expect(shown).toContainText('point 14')

  const saved = await (await page.request.get(`/api/initiatives/${id.wt}/${id.name}`)).json()
  expect(saved.brief).toBe(`${text}\n`)
  expect(saved.uncommitted).toBe(false)

  await page.getByRole('button', { name: 'Edit brief' }).click()
  await expect(page.getByLabel('Brief text')).toHaveValue(`${text}\n`)
  await page.getByLabel('Brief text').fill('Throw this away.')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(shown.locator('strong')).toHaveText('edited')
  expect((await (await page.request.get(`/api/initiatives/${id.wt}/${id.name}`)).json()).brief).toBe(`${text}\n`)
})
