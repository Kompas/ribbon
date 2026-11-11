// Who the session is signed in as, and the usage the account's server reports.
// Pure helpers: the band hands them what it read through `$`.

import type { Plan, Window } from '../types'

/** The endpoint `/usage` reads: the account's 5-hour and 7-day windows, no tokens spent. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const USAGE_BETA = 'oauth-2025-04-20'

/**
 * The windows in the usage endpoint's answer, as the band keeps them.
 * Anything it does not recognise is left out, so a changed answer shows less, never wrong.
 */
export const parseUsage = (text: string): Window[] | null => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const out: Window[] = []
  for (const kind of ['seven_day', 'five_hour'] as const) {
    const w = (body as Record<string, unknown>)[kind]
    if (!w || typeof w !== 'object') continue
    const used = (w as Record<string, unknown>).utilization
    const resets = (w as Record<string, unknown>).resets_at
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    out.push({
      kind,
      percentUsed: Math.max(0, Math.min(100, used)),
      ...(typeof resets === 'string' ? { resetsAt: resets } : {}),
    })
  }
  return out.length > 0 ? out : null
}

/**
 * A fingerprint of the signed-in account from the config file's `oauthAccount`:
 * the account and the organization ids, joined. Never shown, never sent:
 * only compared, so a /login to another account or organization is noticed.
 */
export const accountKeyOf = (configText: string): string | null => {
  try {
    const a = (JSON.parse(configText) as { oauthAccount?: Record<string, unknown> }).oauthAccount
    if (!a) return null
    const user = typeof a.accountUuid === 'string' ? a.accountUuid : ''
    const org = typeof a.organizationUuid === 'string' ? a.organizationUuid : ''
    return user || org ? `${user}/${org}` : null
  } catch {
    return null
  }
}

/** A base URL that is not Anthropic's own: a gateway, a proxy or a local model server. */
export const isForeignBase = (url: string | undefined): boolean => {
  if (!url) return false
  try {
    return !/(^|\.)anthropic\.com$/i.test(new URL(url).hostname)
  } catch {
    return true
  }
}

/**
 * How the session pays, from what the engine and the environment say:
 * - `subscription`: a claude.ai login, with 5-hour and 7-day windows
 * - `api`: an Anthropic API key, billed per token, no windows
 * - `other`: a cloud provider, a gateway or a local model: no windows, maybe no cache
 */
export const planOf = (auth: { kind: 'bearer' | 'api-key' } | null, env: { base?: string; cloud: boolean }): Plan => {
  if (env.cloud || isForeignBase(env.base) || !auth) return 'other'
  return auth.kind === 'bearer' ? 'subscription' : 'api'
}
