import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, CacheFacts, Fold, Plan, Window } from '../types'
import { USAGE_BETA, USAGE_URL, accountKeyOf, parseUsage, planOf } from './account'
import {
  TTL_MIN, TTL_MS, bandPx, cardKindOf, cardSvg, familyOf, fmtIdle, mineModel, myCost, tok, usd,
} from './cache-art'
import type { CacheView } from './cache-art'

// A quiet band above the prompt. On a Claude plan it shows how much of the
// week and of the 5-hour window is LEFT and when each resets; on an API key,
// a cloud provider or a local model it shows the model and the context instead
// of waiting for limits that never come. After the first reply it adds the
// prompt cache: warm (cheap to continue) or cold (the next message re-sends the
// whole chat), with what that costs. Colours are the theme's own, so it follows
// light and dark. It never calls a model.

const CELLS = 10
const TIGHT_CELLS = 6
const LOW_AT = 15
const EMPTY_AT = 5
const GAP = 3
/** Columns the desktop's Details / Hide button and its margin take beside the row. */
const BUTTON_COLS = 12
/** How often the band redraws and looks for an account switch. */
const TICK_MS = 30_000
/** How often the account's usage is asked for while idle, and the wait after a refusal. */
const FETCH_MS = 5 * 60_000
const BACKOFF_MS = 15 * 60_000

const windows = atom({ plugin: 'ribbon', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'ribbon', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'ribbon', key: 'fold' } as const, null as Fold | null)
const account = atom({ plugin: 'ribbon', key: 'account' } as const, null as Account | null)

const NAMES: Record<string, string> = { seven_day: 'Week', five_hour: '5-hour', spend_limit: 'Spend' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

export const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '●'.repeat(n), off: '○'.repeat(cells - n) }
}

export const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `resets in ${hours}h ${mins % 60}m`
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What the cache reads, or null until a request is known, and for a model the band can't price. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const mine = familyOf(c.model)
  // A local model or a gateway's own name: its cache, if any, isn't Anthropic's hour.
  if (!mine) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine,
    ...(typeof c.usd === 'number' ? { usd: c.usd } : {}),
  }
}

/** The model's name the way a person reads it: `claude-opus-5-5` is `opus-5-5`. */
const shortModel = (m: string | null): string => (m ? m.replace(/^claude-/, '').replace(/\[1m\]$/, '') : '')

export const LEGEND = [
  'ribbon: what the band shows',
  '',
  '  Week ●●●●●●●○○○ 71% left · resets in 3d 9h',
  '    How much of your plan\'s 7-day allowance is left, and when it refills.',
  '  5-hour ●●●●●●●●●○ 92% left · resets in 2h 10m',
  '    The same for the rolling 5-hour window. LOW shows under 15%.',
  '  Context 34%',
  '    How full this conversation\'s context window is. Near 100% it gets compacted.',
  '  Cache warm · cold in 56m',
  '    Your conversation is in Anthropic\'s prompt cache: the next message is cheap.',
  '    The cache lasts an hour after your last message.',
  '  Cache cold · next msg $4.78',
  '    The hour has passed: the next message re-sends the whole chat at full price.',
  '    Details opens a card with the price on each model.',
  '',
  'On an API key it shows the session\'s cost; on a cloud provider, gateway or local',
  'model it shows the model and the context only (no plan limits apply there).',
  'The [-] at the band\'s right is Claude Code\'s own: it folds the band away.',
].join('\n')

// The module's own memory of the account watch; a reload starts it over, harmlessly.
let configPath: string | null = null
let configMtime = -1
let accountKey: string | null | undefined
let nextFetchAt = 0

/** An environment variable, or undefined where the host keeps none. */
const envOf = async ($: EngineInterface, name: 'ANTHROPIC_BASE_URL' | 'CLAUDE_CODE_USE_BEDROCK' | 'CLAUDE_CODE_USE_VERTEX' | 'CLAUDE_CODE_USE_FOUNDRY' | 'CLAUDE_CONFIG_DIR' | 'HOME'): Promise<string | undefined> => {
  switch (name) {
    case 'ANTHROPIC_BASE_URL': return $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined)
    case 'CLAUDE_CODE_USE_BEDROCK': return $.env.get('CLAUDE_CODE_USE_BEDROCK').catch(() => undefined)
    case 'CLAUDE_CODE_USE_VERTEX': return $.env.get('CLAUDE_CODE_USE_VERTEX').catch(() => undefined)
    case 'CLAUDE_CODE_USE_FOUNDRY': return $.env.get('CLAUDE_CODE_USE_FOUNDRY').catch(() => undefined)
    case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
    case 'HOME': return $.env.get('HOME').catch(() => undefined)
  }
}

const detectPlan = async ($: EngineInterface): Promise<Plan> => {
  const auth = await $.session.authorize().catch(() => null)
  const base = await envOf($, 'ANTHROPIC_BASE_URL')
  const cloud =
    !!(await envOf($, 'CLAUDE_CODE_USE_BEDROCK')) ||
    !!(await envOf($, 'CLAUDE_CODE_USE_VERTEX')) ||
    !!(await envOf($, 'CLAUDE_CODE_USE_FOUNDRY'))
  return planOf(auth, { base, cloud })
}

/** The account's windows straight from its server, so the band needn't wait for a reply. */
const fetchUsage = async ($: EngineInterface, force = false): Promise<void> => {
  const now = await $.clock.now()
  if (!force && now < nextFetchAt) return
  nextFetchAt = now + FETCH_MS
  try {
    const a = await read($, account)
    if (a && a.plan !== 'subscription') return
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return
    const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': USAGE_BETA } })
    if (!r.ok) {
      if (r.status === 429) nextFetchAt = now + BACKOFF_MS
      return
    }
    const list = parseUsage(r.text)
    if (list) await update($, windows, () => clean(list))
  } catch {
    // No network, nonessential traffic off, or a policy: the next reply's figures still come.
  }
}

/** Notices a /login to another account or organization, here or in another session. */
const checkAccount = async ($: EngineInterface, force = false): Promise<void> => {
  try {
    if (!configPath) {
      const dir = (await envOf($, 'CLAUDE_CONFIG_DIR')) || (await envOf($, 'HOME'))
      if (!dir) return
      configPath = `${dir.replace(/\/$/, '')}/.claude.json`
    }
    const st = await $.fs.stat(configPath)
    if (!force && st.mtimeMs === configMtime) return
    configMtime = st.mtimeMs
    const key = accountKeyOf(await $.fs.read(configPath))
    if (accountKey === undefined) {
      accountKey = key
      return
    }
    if (key === accountKey && !force) return
    const changed = key !== accountKey
    accountKey = key
    if (!changed) return
    // Another account: its limits, its plan and its cache are its own.
    await update($, windows, () => [])
    await update($, cache, () => null)
    await update($, fold, () => null)
    const plan = await detectPlan($)
    await update($, account, () => ({ plan, replied: false }))
    await fetchUsage($, true)
    $.ui.toast('ribbon: account changed, usage refreshed')
  } catch {
    // No config file (a cloud provider, an SDK host): nothing to watch.
  }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Each step on its own: a band that fails to seed one part still draws the rest.
    const step = (p: Promise<unknown>) => p.catch(() => undefined)
    await step(
      (async () => {
        const u = await $.session.usage()
        if (u.rateLimits.length > 0) await update($, windows, () => clean(u.rateLimits))
      })(),
    )
    await step(
      (async () => {
        const plan = await detectPlan($)
        await update($, account, a => ({ plan, replied: a?.replied ?? false, ...(a?.usd ? { usd: a.usd } : {}) }))
      })(),
    )
    await step(checkAccount($))
    await step(fetchUsage($, true))
    await step($.command.register({ name: 'ribbon', description: 'Explain what the ribbon band above the prompt shows' }))
    $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      void checkAccount($).then(() => fetchUsage($))
    })
    return r
  })

  on('command.run', { command: 'ribbon' }, () => ({ text: LEGEND }))

  // After a /login or /logout, look at once rather than at the next tick.
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    if (e.command === 'login' || e.command === 'logout') {
      await checkAccount($, true)
      await fetchUsage($, true)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
        await update($, windows, () => clean(e.rateLimits))
      }
      if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
        const tokens = e.context.tokens
        await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
      }
      if (e.changed.includes('cost') && e.cost) {
        const usdNow = e.cost.usd
        await update($, account, a => (a ? { ...a, usd: usdNow } : a))
      }
    } catch {
      // Drawing data only.
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away, how big it is, and
  // what Claude Code itself reckons re-caching costs.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      const est = (e as { estimated_cache_write_usd?: unknown }).estimated_cache_write_usd
      await update($, cache, () => ({ lastAt, tokens, window, model, ...(typeof est === 'number' ? { usd: est } : {}) }))
    }
    return r
  }).catch(($, e, next) => next(e))

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0, window: c?.window ?? 0, model: c?.model ?? null }))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    try {
      const now = await $.clock.now()
      const c = await read($, cache)
      const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
      const u = await $.session.usage()
      const model = e.usage?.model ?? (await $.session.model())
      await update($, cache, c2 => ({
        lastAt,
        tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c2?.tokens ?? 0),
        window: u.context.window || c2?.window || 0,
        model: model || c2?.model || null,
      }))
      if (u.rateLimits.length > 0) await update($, windows, () => clean(u.rateLimits))
      await update($, account, a => ({ plan: a?.plan ?? 'other', replied: true, ...(u.cost ? { usd: u.cost.usd } : a?.usd ? { usd: a.usd } : {}) }))
    } catch {
      // Drawing data only.
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // Another mod's band beneath this one still draws, above ribbon's.
    const beneath = await Promise.resolve(next(e)).catch(() => null)
    const above = beneath && typeof beneath === 'object' && (beneath as { type?: string }).type !== 'engine' ? beneath : null

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal has no card.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const now = await $.clock.now()
    const list = await read($, windows)
    const facts = await read($, cache)
    const view = viewOf(facts, now)
    const acct = await read($, account)
    const plan: Plan = acct?.plan ?? 'subscription'
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    // ---- What there is to say, as items of text with a measured width ----
    type Part = { text: string; color?: string; bold?: boolean; dim?: boolean }
    type Item = { key: string; line: Part[]; block: Part[][] }
    const width = (parts: Part[]) => parts.reduce((n, p) => n + p.text.length, 0)

    const windowItem = (w: Window, cells: number): Item => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      const d = dots(left, cells)
      const fill = left < EMPTY_AT ? 'error' : left < LOW_AT ? 'warning' : 'claude'
      const name = NAMES[w.kind] ?? w.kind
      const reset = fmtReset(w.resetsAt, now)
      const low: Part[] = left < LOW_AT ? [{ text: ' LOW', color: 'warning', bold: true }] : []
      return {
        key: `w-${w.kind}`,
        line: [
          { text: `${name} `, color: 'subtle', bold: true },
          { text: d.on, color: fill },
          { text: d.off, color: 'inactive' },
          { text: ` ${left}% left`, color: 'text', bold: true },
          ...low,
          ...(reset ? [{ text: ` · ${reset}`, color: 'subtle' }] : []),
        ],
        block: [
          [{ text: `${name} `, color: 'subtle', bold: true }, { text: d.on, color: fill }, { text: d.off, color: 'inactive' }],
          [{ text: `${left}% left`, color: 'text', bold: true }, ...low],
          ...(reset ? [[{ text: reset, color: 'subtle' }]] : []),
        ],
      }
    }

    const ctxTokens = facts?.tokens ?? 0
    const ctxWindow = facts?.window ?? 0
    const ctxPct = ctxWindow > 0 && ctxTokens > 0 ? Math.min(100, Math.round((ctxTokens / ctxWindow) * 100)) : null
    const contextItem: Item | null =
      ctxPct === null
        ? null
        : {
            key: 'context',
            line: [
              { text: 'Context ', color: 'subtle', bold: true },
              { text: `${ctxPct}%`, color: ctxPct >= 85 ? 'warning' : 'text', bold: true },
            ],
            block: [
              [{ text: 'Context', color: 'subtle', bold: true }],
              [{ text: `${ctxPct}% used`, color: ctxPct >= 85 ? 'warning' : 'text', bold: true }],
              [{ text: `${tok(ctxTokens)} of ${tok(ctxWindow)}`, color: 'subtle' }],
            ],
          }

    const mine = view ? mineModel(view) : undefined
    const cold = view?.mode === 'cold'
    const hue = cold ? 'suggestion' : 'claude'
    const left = view ? Math.max(0, TTL_MIN - view.idleMin) : 0
    const price = view && mine ? usd(myCost(view, mine)) : null
    const cacheItem: Item | null = !view
      ? null
      : {
          key: 'cache',
          line: [
            { text: 'Cache ', color: 'subtle', bold: true },
            { text: cold ? 'cold' : 'warm', color: hue, bold: true },
            { text: cold ? ` ${view.idle}` : ` · cold in ${left}m`, color: 'subtle' },
            ...(cold && price ? [{ text: ' · next msg ', color: 'subtle' }, { text: price, color: 'text', bold: true }] : []),
          ],
          block: [
            [{ text: 'Cache ', color: 'subtle', bold: true }, { text: cold ? 'cold' : 'warm', color: hue, bold: true }],
            [{ text: cold ? `idle ${view.idle}` : `cold in ${left}m`, color: 'subtle' }],
            ...(price ? [[{ text: price, color: 'text', bold: true }, { text: ' next msg', color: 'subtle' }]] : []),
          ],
        }

    // Off a plan there are no windows to wait for: say what the session is instead.
    const replied = acct?.replied ?? false
    const noWindows = list.length === 0 && (plan !== 'subscription' || replied)
    const headItem = (): Item | null => {
      if (list.length > 0) return null
      if (!noWindows) {
        return {
          key: 'wait',
          line: [{ text: 'Usage ', color: 'subtle', bold: true }, { text: 'shows after your first reply', color: 'inactive' }],
          block: [[{ text: 'Usage', color: 'subtle', bold: true }], [{ text: 'after first reply', color: 'inactive' }]],
        }
      }
      if (plan === 'api') {
        const cost = acct?.usd
        return {
          key: 'api',
          line: [{ text: 'API key', color: 'subtle', bold: true }, ...(typeof cost === 'number' ? [{ text: ' · session ', color: 'subtle' }, { text: usd(cost), color: 'text', bold: true }] : [])],
          block: [[{ text: 'API key', color: 'subtle', bold: true }], ...(typeof cost === 'number' ? [[{ text: `${usd(cost)} so far`, color: 'text', bold: true }]] : [])],
        }
      }
      const model = shortModel(facts?.model ?? null)
      const label = plan === 'other' ? 'Model' : 'No plan limits'
      return {
        key: 'model',
        line: [{ text: label, color: 'subtle', bold: true }, ...(model && plan === 'other' ? [{ text: ` ${model}`, color: 'text', bold: true }] : [])],
        block: [[{ text: label, color: 'subtle', bold: true }], ...(model && plan === 'other' ? [[{ text: model, color: 'text', bold: true }]] : [])],
      }
    }

    const head = headItem()
    const fits = (cells: number) => [...list.map(w => windowItem(w, cells)), ...(head ? [head] : []), ...(contextItem ? [contextItem] : []), ...(cacheItem ? [cacheItem] : [])]

    // ---- Details / Hide: the cache card, a drawing, so not on the terminal ----
    const stored = await read($, fold)
    const mode = view?.mode ?? 'warm'
    const canOpen = Svg !== null && view !== null
    const open = canOpen && (stored && stored.mode === mode ? stored.open : cold)
    const toggle = () => update($, fold, f => ({ mode, open: !(f && f.mode === mode ? f.open : mode === 'cold') }))
    const buttonCols = canOpen ? BUTTON_COLS : 0

    // ---- Pick the layout by measuring, so nothing is clipped ----
    const room = columns - 2 - buttonCols
    const rowWidth = (items: Item[]) => items.reduce((n, it) => n + width(it.line), 0) + GAP * Math.max(0, items.length - 1)
    const blockWidth = (items: Item[]) =>
      items.reduce((n, it) => n + Math.max(...it.block.map(width)), 0) + GAP * Math.max(0, items.length - 1)
    // One row with full bars, one row with short bars, a block per item, then short-bar blocks that wrap.
    const full = fits(CELLS)
    const narrow = fits(TIGHT_CELLS)
    const kind: 'row' | 'blocks' | 'tight' =
      rowWidth(full) <= room || rowWidth(narrow) <= room ? 'row' : blockWidth(full) <= room ? 'blocks' : 'tight'
    const items = kind === 'row' ? (rowWidth(full) <= room ? full : narrow) : kind === 'tight' ? narrow : full

    const draw = (parts: Part[], key: string) => (
      <Box key={key} flexDirection="row" flexShrink={0}>
        {parts.map((p, i) => (
          <Text key={`${key}-${i}`} color={p.color} bold={p.bold} dimColor={p.dim}>{p.text}</Text>
        ))}
      </Box>
    )

    const body =
      kind === 'row'
        ? items.map((it, i) => (
            <Box key={it.key} flexShrink={0} marginRight={i < items.length - 1 ? GAP : 0}>
              {draw(it.line, `${it.key}-l`)}
            </Box>
          ))
        : items.map(it => (
            <Box key={it.key} flexDirection="column" flexShrink={0} marginRight={GAP}>
              {it.block.map((ln, j) => draw(ln, `${it.key}-${j}`))}
            </Box>
          ))

    const button = canOpen ? (
      <Box key="fold" flexShrink={0} marginLeft={1} alignItems="flex-start">
        <Button key="cache-fold" label={open ? 'Hide' : 'Details'} onPress={toggle} />
      </Box>
    ) : null

    let card = null
    if (open && Svg && view) {
      const px = bandPx(columns)
      const c = cardSvg(view, cardKindOf(px, columns), px)
      card = (
        <Box key="card" flexDirection="row">
          <Svg source={c.source} alt={c.alt} width={c.w} height={c.h} isInteractive={columns >= 42} />
        </Box>
      )
    }

    const own = (
      <Box key="ribbon" flexDirection="column">
        <Box key="top" flexDirection="row" flexWrap="nowrap">
          <Box key="row" flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} paddingX={1} alignItems={kind === 'row' ? 'center' : 'flex-start'}>
            {body}
          </Box>
          {button}
        </Box>
        {card}
      </Box>
    )

    return above ? (
      <Box flexDirection="column">
        {above}
        {own}
      </Box>
    ) : own
  })
}
