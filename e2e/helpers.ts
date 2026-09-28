import { expect, type Page } from '@playwright/test'

// Creates an initiative through the New feature form and waits for its screen; returns its id.
export async function newInitiative(page: Page, name: string, fill: Record<string, string> = {}): Promise<{ wt: string; name: string }> {
  await page.goto('/?t=e2e')
  await page.getByRole('button', { name: '+ New feature' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Title', { exact: true }).fill(fill.title ?? 'Live refresh')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({ timeout: 20_000 })
  const wt = /#\/i\/([^/]+)\//.exec(page.url())?.[1] ?? ''
  return { wt, name }
}
