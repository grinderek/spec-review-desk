import { expect, type Page, test } from '@playwright/test'
import { newInitiative } from './helpers.ts'

// Desk fixes item 1: an initiative mutation shows on the screen without a page reload — and it
// already shows when the action reports success (the toast), never a moment later.
interface AtToast { main: string; tabs: string[] }

// Records what the main pane shows at the very DOM mutation that inserts the toast `text`.
async function captureAtToast(page: Page, text: string): Promise<() => Promise<AtToast | null>> {
  await page.evaluate((wanted) => {
    const w = window as unknown as { __atToast: unknown }
    w.__atToast = null
    const observer = new MutationObserver(() => {
      const toast = [...document.querySelectorAll('[role="status"]')].find((e) => e.textContent === wanted)
      if (!toast) return
      w.__atToast = {
        main: document.querySelector('main')?.textContent ?? '',
        tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? ''),
      }
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }, text)
  return () => page.evaluate(() => (window as unknown as { __atToast: AtToast | null }).__atToast)
}

test('Add from repo and Plan slices show on the initiative screen without a reload', async ({ page }) => {
  await newInitiative(page, 'live-refresh')
  let navigations = 0
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1 })

  await page.getByRole('tab', { name: /Inputs/ }).click()
  await expect(page.getByText('No inputs yet.')).toBeVisible()
  const added = await captureAtToast(page, 'Input added from the repo')
  await page.getByLabel('Add from repo (path relative to the hub)').fill('api/features/STEPS.md')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('[data-input="STEPS.md"]')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('tab', { name: /Inputs/ }).locator('.c')).toHaveText('1')
  await expect.poll(added).not.toBeNull()
  const atAdded = (await added())!
  expect(atAdded.main).toContain('from api/features/STEPS.md')
  expect(atAdded.tabs).toContain('Inputs1')

  // The fixture's planner for this initiative takes a few seconds, so "running" is observable.
  await page.getByRole('tab', { name: /Plan/ }).click()
  const started = await captureAtToast(page, 'Planner started')
  await page.getByRole('button', { name: 'Plan slices' }).click()
  await expect(page.getByText('The planner is proposing slices…')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.gate')).toContainText('1 running')
  await expect.poll(started).not.toBeNull()
  const atStarted = (await started())!
  expect(atStarted.main).toContain('The planner is proposing slices…')
  expect(atStarted.main).toContain('1 running')
  expect(atStarted.tabs).toContain('Runs1')

  await page.getByRole('tab', { name: /Runs/ }).click()
  await expect(page.locator('[data-run]').first()).toContainText('running')
  // …and when it finishes, the draft plan and the idle header arrive the same way.
  await expect(page.locator('.gate')).toContainText('idle', { timeout: 20_000 })
  await page.getByRole('tab', { name: /Plan/ }).click()
  await expect(page.getByLabel('Title of slice 1')).toHaveValue('Engine')
  expect(navigations).toBe(0)
})
