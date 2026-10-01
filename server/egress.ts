// Spec B §4.5/§5: the per-run egress allowlist of the tinyproxy companion (ruling 1). One anchored
// `host:443` line per host (tinyproxy runs with FilterURLs On, so HTTPS to port 443 is all that passes —
// review fix 1); the OpenAI API is always the first line of the agent's filter.
export const OPENAI_API = 'api.openai.com'
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const HOST_IN_TEXT = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi

// The one decision a research run may raise (spec B §4.5).
export const FETCH_DOMAINS = { id: 'fetch-domains', options: ['allow_all', 'allow_some', 'search_only'] } as const

export function normalizeDomain(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, '')
  return HOSTNAME.test(host) ? host : null
}

const escape = (host: string): string => host.replace(/[.]/g, '\\.')

function plainHosts(domains: readonly string[]): string[] {
  return domains.map((d) => {
    const host = normalizeDomain(d)
    if (!host) throw new Error(`egress: "${d}" is not a plain hostname`)
    return host
  })
}

const filterLines = (hosts: readonly string[]): string => [...new Set(hosts)].map((h) => `^${escape(h)}:443$\n`).join('')

// The agent's proxy: the OpenAI API plus the approved research domains (WebFetch).
export function egressFilter(domains: readonly string[]): string {
  return filterLines([OPENAI_API, 'www.bing.com', ...plainHosts(domains)])
}

// The research browser's own proxy (controller ruling 2): only the approved research domains — never
// the OpenAI API, so a page's script cannot send anything there.
export function browserFilter(domains: readonly string[]): string {
  return filterLines(plainHosts(domains).filter((h) => h !== OPENAI_API && h !== 'www.bing.com'))
}

export function domainsFromText(text: string): string[] {
  const found = (text.match(HOST_IN_TEXT) ?? []).flatMap((m) => {
    const host = normalizeDomain(m)
    return host ? [host] : []
  })
  return [...new Set(found)]
}

// Ruling 3: allow_all approves every requested host, allow_some the hosts the owner names in the
// note, search_only none.
export function approvedDomains(requested: readonly string[], choice: { option: string | null; note: string } | null): string[] {
  if (choice?.option === 'allow_all') return [...requested]
  if (choice?.option === 'allow_some') return domainsFromText(choice.note)
  return []
}
