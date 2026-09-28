import { expect, type Page, test } from '@playwright/test'

// Desk fixes item 3: in the pilot run the Brief and "Add from repo" textareas of New feature arrived
// empty (brief.md was 1 byte, no inputs). The form was filled by chrome-devtools-mcp's `fill`, whose
// Puppeteer Locator.fill types a value shorter than 100 characters but sets a longer one directly
// (`el.value = …` + a synthetic input event), which a React-controlled field never sees.
const BRIEF = [
  '# What',
  '',
  'Business health score = the Daily Operating Score spec v1.0 (`scoring_version: daily_operating_score_v1`),',
  'built slice by slice under the behavior-driven method.',
].join('\n')
const FROM_REPO = ['api/features/STEPS.md', 'api/openspec/changes/add-thread-state/proposal.md', 'config.yaml'].join('\n')

async function openForm(page: Page, name: string): Promise<void> {
  await page.goto('/?t=e2e')
  await page.getByRole('button', { name: '+ New feature' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Title', { exact: true }).fill(`Filled by ${name}`)
}

async function createAndRead(page: Page, name: string): Promise<{ brief: string; inputs: { file: string; source: { kind: string; path?: string } }[] }> {
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({ timeout: 20_000 })
  const wt = /#\/i\/([^/]+)\//.exec(page.url())![1]
  return (await page.request.get(`/api/initiatives/${wt}/${name}`)).json()
}

const expectArrived = (view: Awaited<ReturnType<typeof createAndRead>>) => {
  expect(view.brief).toBe(`${BRIEF}\n`)
  expect(view.inputs.map((i) => [i.file, i.source.kind, i.source.path])).toEqual([
    ['STEPS.md', 'repo', 'api/features/STEPS.md'],
    ['proposal.md', 'repo', 'api/openspec/changes/add-thread-state/proposal.md'],
    ['config.yaml', 'repo', 'config.yaml'],
  ])
}

test('New feature: textareas filled with page.fill arrive on the server', async ({ page }) => {
  await openForm(page, 'nf-fill')
  await page.getByLabel('Brief', { exact: true }).fill(BRIEF)
  await page.getByLabel('Add from repo (one path per line, relative to the hub)').fill(FROM_REPO)
  expectArrived(await createAndRead(page, 'nf-fill'))
})

test('New feature: textareas typed key by key arrive on the server', async ({ page }) => {
  await openForm(page, 'nf-typed')
  await page.getByLabel('Brief', { exact: true }).click()
  await page.keyboard.type(BRIEF)
  await page.getByLabel('Add from repo (one path per line, relative to the hub)').click()
  await page.keyboard.type(FROM_REPO)
  expectArrived(await createAndRead(page, 'nf-typed'))
})

test('New feature: a value set directly on the textarea (the CDP automation path) still arrives', async ({ page }) => {
  await openForm(page, 'nf-direct')
  // What Puppeteer's Locator.fill does for a value of 100+ characters.
  const setDirectly = (label: string, value: string) =>
    page.getByLabel(label, { exact: true }).evaluate((el, v) => {
      (el as HTMLTextAreaElement).value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
  await setDirectly('Brief', BRIEF)
  await setDirectly('Add from repo (one path per line, relative to the hub)', FROM_REPO)
  expectArrived(await createAndRead(page, 'nf-direct'))
})

test('New feature: an unreadable repo path fails the create with its name, nothing is created', async ({ page }) => {
  await openForm(page, 'nf-missing')
  await page.getByLabel('Add from repo (one path per line, relative to the hub)').fill('api/features/STEPS.md\napi/doc/no-such-file.md')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('status')).toContainText('api/doc/no-such-file.md')
  await expect(page.getByRole('heading', { name: 'New feature' })).toBeVisible()
  const listed = (await (await page.request.get('/api/initiatives')).json()) as { initiatives: { name: string }[] }
  expect(listed.initiatives.map((i) => i.name)).not.toContain('nf-missing')
})
