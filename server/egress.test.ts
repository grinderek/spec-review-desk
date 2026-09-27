import { describe, expect, it } from 'vitest'
import { approvedDomains, domainsFromText, egressFilter, FETCH_DOMAINS, normalizeDomain } from './egress.ts'

describe('normalizeDomain', () => {
  it('accepts plain hostnames, lower-cased, without a trailing dot', () => {
    expect(normalizeDomain(' Developer.Intuit.com. ')).toBe('developer.intuit.com')
    expect(normalizeDomain('docs.stripe.com')).toBe('docs.stripe.com')
  })

  it('rejects URLs, IPs, wildcards, ports and single labels', () => {
    for (const bad of ['https://docs.stripe.com', '10.0.0.1', '*.stripe.com', 'stripe.com:443', 'localhost', 'a..b.com', '-a.com', '']) {
      expect(normalizeDomain(bad)).toBeNull()
    }
  })
})

describe('egressFilter', () => {
  it('always allows the Anthropic API, one anchored, escaped line per extra domain, no duplicates', () => {
    expect(egressFilter([])).toBe('^api\\.anthropic\\.com$\n')
    expect(egressFilter(['developer.intuit.com', 'docs.stripe.com', 'developer.intuit.com', 'api.anthropic.com'])).toBe(
      '^api\\.anthropic\\.com$\n^developer\\.intuit\\.com$\n^docs\\.stripe\\.com$\n',
    )
  })

  it('refuses a domain that is not a plain hostname', () => {
    expect(() => egressFilter(['evil.com$|.*'])).toThrow(/not a plain hostname/)
  })
})

describe('domainsFromText', () => {
  it('reads the hostnames an owner names in a note', () => {
    expect(domainsFromText('Only developer.intuit.com and https://docs.stripe.com/api, not 10.0.0.1')).toEqual([
      'developer.intuit.com',
      'docs.stripe.com',
    ])
  })
})

describe('approvedDomains', () => {
  const requested = ['developer.intuit.com', 'docs.stripe.com']
  it('maps the fetch-domains choice to the domains it approves', () => {
    expect(FETCH_DOMAINS.options).toEqual(['allow_all', 'allow_some', 'search_only'])
    expect(approvedDomains(requested, { option: 'allow_all', note: '' })).toEqual(requested)
    expect(approvedDomains(requested, { option: 'allow_some', note: 'docs.stripe.com only; also plaid.com' })).toEqual(['docs.stripe.com', 'plaid.com'])
    expect(approvedDomains(requested, { option: 'search_only', note: 'docs.stripe.com' })).toEqual([])
    expect(approvedDomains(requested, null)).toEqual([])
  })
})
