import { expect, test } from '@playwright/test'
import { newInitiative } from './helpers.ts'

// Review fix 4: Chrome allows 6 HTTP/1.1 connections per host, shared by every Desk tab. Each open
// EventSource holds one for good, so the Desk must not open one per run card on top of
// /api/events: with a few running runs (and a second Desk tab) every GET would queue behind the
// streams until a reload closed them — a screen that "does not refresh".
test('an initiative with several running runs holds one event stream, and still refreshes and streams', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.EventSource
    const w = window as unknown as { __es: { open: number; max: number; urls: string[] } }
    w.__es = { open: 0, max: 0, urls: [] }
    // No class fields: Playwright's transpiler would turn them into helpers the page lacks.
    const closed = new WeakSet<EventSource>()
    class Counted extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        w.__es.open += 1
        w.__es.max = Math.max(w.__es.max, w.__es.open)
        w.__es.urls.push(String(url))
      }
      close(): void {
        if (!closed.has(this)) w.__es.open -= 1
        closed.add(this)
        super.close()
      }
    }
    window.EventSource = Counted
  })
  const streams = () => page.evaluate(() => (window as unknown as { __es: { open: number; max: number; urls: string[] } }).__es)

  await newInitiative(page, 'streams')
  await page.getByRole('tab', { name: /Research/ }).click()
  for (const topic of ['Slow topic A', 'Slow topic B', 'Slow topic C']) {
    await page.getByLabel('Research topic').fill(topic)
    await page.getByLabel('Research questions').fill('Which report?')
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await expect(page.getByLabel('Research topic')).toHaveValue('')
  }
  await page.getByRole('tab', { name: /Runs/ }).click()
  await expect(page.locator('[data-run] .pill', { hasText: 'running' })).toHaveCount(3)
  await expect(page.locator('.gate')).toContainText('3 running')
  expect((await streams()).open).toBeLessThanOrEqual(2)

  // A mutation still refreshes the screen while the runs are streaming.
  await page.getByRole('tab', { name: /Inputs/ }).click()
  await page.getByLabel('Add from repo (path relative to the hub)').fill('api/features/STEPS.md')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('[data-input="STEPS.md"]')).toBeVisible({ timeout: 5_000 })

  // The runs' live text still arrives, and when they finish the screen follows.
  await page.getByRole('tab', { name: /Runs/ }).click()
  await expect(page.locator('[data-run] .stream').first()).toContainText('Working through the room.', { timeout: 5_000 })
  await expect(page.locator('.gate')).toContainText('idle', { timeout: 20_000 })
  await expect(page.getByRole('tab', { name: /Inputs/ }).locator('.c')).toHaveText('4')
  const seen = await streams()
  expect(seen.max, seen.urls.join(' ')).toBeLessThanOrEqual(2)
  expect(new Set(seen.urls).size, 'never two streams for the same url').toBe(seen.urls.length)
})
