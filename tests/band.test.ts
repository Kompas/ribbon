import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: '2099-01-01T00:00:00Z' },
  { kind: 'seven_day', percentUsed: 12.5 },
]

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
} as const

const CONFIG = (account: string) => JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: 'org-1' } })
const USAGE = (five: number, week: number) =>
  JSON.stringify({ five_hour: { utilization: five, resets_at: '2099-01-01T01:00:00Z' }, seven_day: { utilization: week, resets_at: '2099-01-03T22:00:00Z' } })

const turn = { answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('the band shows percent left for each window, the week first, in theme colours', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'ribbon', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: ' 42% left' })).toBeDefined()
    expect(await band.find({ text: ' 87.5% left' })).toBeDefined()
    expect(await band.find({ text: ' · resets in 2h 0m' })).toBeDefined()
    const all = JSON.stringify(await band.find({ type: 'Box' }))
    expect(all.indexOf('Week')).toBeLessThan(all.indexOf('5-hour'))
    // No fixed dark slab: the theme paints the band.
    expect(all).not.toContain('backgroundColor')
    expect(all).toContain('"claude"')
    await band.unmount()
  }
})

test('in a narrow band each window stacks, with percent left and reset time on their own lines', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 36 } })
  expect(await band.find({ text: '42% left' })).toBeDefined()
  expect(await band.find({ text: 'resets in 2h 0m' })).toBeDefined()
  await band.unmount()
})

test('on a plan, usage shows at once from the account, before any reply', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE(10, 30) } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' 90% left' })).toBeDefined()
  expect(await band.find({ text: ' 70% left' })).toBeDefined()
  await band.unmount()
})

test('on a plan whose usage cannot be read yet, the band says when it will show', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'shows after your first reply' })).toBeDefined()
  await band.unmount()
})

test('a local model never waits for limits: it shows the model and the context', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { ANTHROPIC_BASE_URL: 'http://localhost:8000', HOME: '/home/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 128000, tokens: 32000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: null }))
  on('session.model', () => ({ value: 'qwen3-coder-30b' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const before = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await before.find({ text: 'shows after your first reply' })).toBeUndefined()
  expect(await before.find({ text: 'Model' })).toBeDefined()
  await before.unmount()

  await $.turn.complete(turn)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' qwen3-coder-30b' })).toBeDefined()
  expect(await band.find({ text: '25%' })).toBeDefined()
  // Its cache isn't Anthropic's hour: no cache, no card.
  expect(await band.find({ key: 'cache-fold' })).toBeUndefined()
  expect(JSON.stringify(await band.find({ type: 'Box' }))).not.toContain('Cache')
  await band.unmount()
})

test('an API key shows what the session has cost instead of plan limits', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 50000 }, rateLimits: [], cost: { usd: 1.234 } } }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn)

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'API key' })).toBeDefined()
  expect(await band.find({ text: '$1.23' })).toBeDefined()
  expect(await band.find({ text: 'warm' })).toBeDefined()
  await band.unmount()
})

test('switching account clears the old usage and loads the new one without a new session', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  let config = CONFIG('alice')
  let mtime = 1
  let usage = USAGE(10, 30)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: usage } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: config.length, mtimeMs: mtime, isLink: false } }))
  on('fs.read', () => ({ value: config }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' 90% left' })).toBeDefined()

  // /login as someone else: the config file now names another account.
  config = CONFIG('bob')
  mtime = 2
  usage = USAGE(80, 95)
  await clock.advance(30_000)
  expect(await band.find({ text: ' 90% left' })).toBeUndefined()
  expect(await band.find({ text: ' 20% left' })).toBeDefined()
  expect(await band.find({ text: ' 5% left' })).toBeDefined()
  await band.unmount()
})

test('the /ribbon command explains what each part of the band means', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.command.run({ command: 'ribbon' })
  expect(r.text).toContain('Cache warm')
  expect(r.text).toContain('7-day')
})

test("another mod's band beneath ribbon still draws, above ribbon's", async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, { key: 'other' }, h(Text, null, 'OTHER BAND'))
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'OTHER BAND' })).toBeDefined()
  const all = JSON.stringify(await band.find({ type: 'Box' }))
  expect(all.indexOf('OTHER BAND')).toBeLessThan(all.indexOf('Week'))
  await band.unmount()
})

test('minimal style shows numbers only: week, 5-hour, context, cache', { options: { style: 'minimal' } }, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 16000, model: 'claude-opus-5-5' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'ribbon', surface, component: 'AbovePrompt', props: PROPS })
    const all = JSON.stringify(await band.find({ type: 'Box' }))
    for (const t of ['87.5%', '42%', '8%', 'warm', ' 42m']) expect(await band.find({ text: t })).toBeDefined()
    expect(all.indexOf('87.5%')).toBeLessThan(all.indexOf('42%'))
    // No labels, no dot bars, no Details button.
    expect(all).not.toContain('Week')
    expect(all).not.toContain('●')
    expect(await band.find({ key: 'cache-fold' })).toBeUndefined()
    await band.unmount()
  }
})

test('minimal style on a local model shows the model and the context', { options: { style: 'minimal' } }, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { ANTHROPIC_BASE_URL: 'http://localhost:8000', HOME: '/home/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 128000, tokens: 32000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: null }))
  on('session.model', () => ({ value: 'qwen3-coder-30b' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn)

  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'qwen3-coder-30b' })).toBeDefined()
  expect(await band.find({ text: '25%' })).toBeDefined()
  await band.unmount()
})

const seed = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], idleSec: number, limits = WINDOWS) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: limits } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: idleSec, context_tokens: 16000, model: 'claude-opus-5-5' })
}

test('colours muted: grey text, colour kept only for a low window', { options: { colours: 'muted' } }, async ($, on) => {
  await seed($, on, 60, [{ kind: 'seven_day', percentUsed: 90 }])
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const all = JSON.stringify(await band.find({ type: 'Box' }))
  expect(all).not.toContain('"claude"')
  expect(all).not.toContain('"suggestion"')
  expect(all).toContain('"warning"')
  await band.unmount()
})

test('colours off: no colour at all, the warning in bold', { options: { colours: 'off' } }, async ($, on) => {
  await seed($, on, 60, [{ kind: 'seven_day', percentUsed: 90 }])
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const texts = await band.findAll({ type: 'Text' })
  expect(texts.every(t => t.props.color === undefined)).toBe(true)
  expect(texts.find(t => t.props.bold && t.text === ' LOW')).toBeDefined()
  await band.unmount()
})

test('parts: only the context, when the other parts are switched off', { options: { showWeek: false, showFiveHour: false, showCache: false } }, async ($, on) => {
  await seed($, on, 60)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const all = JSON.stringify(await band.find({ type: 'Box' }))
  expect(await band.find({ text: '8%' })).toBeDefined()
  for (const gone of ['Week', '5-hour', 'Cache', 'Usage']) expect(all).not.toContain(gone)
  await band.unmount()
})

test('show when it matters: hidden while all is well, back once the cache goes cold', { options: { show: 'when it matters' } }, async ($, on) => {
  await seed($, on, 60)
  const calm = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await calm.find({ type: 'Box' }) ?? null)).not.toContain('Week')
  await calm.unmount()

  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600, context_tokens: 16000, model: 'claude-opus-5-5' })
  const cold = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await cold.find({ text: 'cold' })).toBeDefined()
  await cold.unmount()
})

test('cache length 5 minutes: cold after 5 minutes, priced at the 1.25x write', { options: { cacheLength: '5 minutes' } }, async ($, on) => {
  await seed($, on, 6 * 60)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'cold' })).toBeDefined()
  // Opus 5.5, 16k tokens, 1.25 x $4 per million: $0.08.
  expect(await band.find({ text: '$0.08' })).toBeDefined()
  await band.unmount()
})
