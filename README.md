# ribbon

A quiet band above your Claude Code prompt:

```
Week ●●●●●●●○○○ 71% left · resets in 3d 9h   5-hour ●●●●●●●●●○ 92% left · resets in 2h 10m   Context 34%   Cache warm · cold in 56m   [ Details ]
```

- **How much usage you have left** this week and in the 5-hour window, and when each one refills.
- **How full the context is.**
- **Whether the prompt cache is warm or cold**, and what your next message costs.

This is a fork of [robonuggets/ribbon](https://github.com/robonuggets/ribbon) by Jay E. The idea and the cache card are his. This fork fixes the things that got in the way in daily use. See [What changed](#what-changed-from-the-original).

## Install

In a terminal:

```
claude plugin install ribbon --marketplace Kompas/ribbon
```

Or inside Claude Code: `/plugin install ribbon --marketplace Kompas/ribbon`, answer `y` to *Add marketplace?*, pick the **user** scope.

Start a new session. The band shows above the prompt.

**Coming from the original?** Remove it first, or you get two bands:

```
claude plugin uninstall ribbon@robonuggets
```

## What you see

Type `/ribbon` in any session for this legend.

| Part | Meaning |
| --- | --- |
| `Week ●●●●●●●○○○ 71% left · resets in 3d 9h` | How much of your plan's 7-day allowance is left, and when it refills. The dots show what is **left**. |
| `5-hour ●●●●●●●●●○ 92% left · resets in 2h 10m` | The same for the rolling 5-hour window. Under 15% the dots turn amber and **LOW** shows; under 5% they turn red. Some plans only report the weekly window; then only `Week` shows, as in Claude Code's own `/usage`. |
| `Context 34%` | How full this conversation's context window is. Amber from 85%. |
| `Cache warm · cold in 56m` | Your chat is in Anthropic's prompt cache, so the next message is cheap. The cache lasts an hour after your last message. |
| `Cache cold 3h 5m · next msg $4.78` | The hour has passed. The next message re-sends the whole chat at full price. |
| `[ Details ]` | Desktop and VS Code: opens a card with the idle time, the cache size and the next-message price on each model. |
| `[-]` at the far right | Claude Code's own control: it folds the whole band away. Click it again to bring the band back. |

### Options

Open `/config` and scroll to **ribbon**. Every change shows at once.

| Option | Choices | What it does |
| --- | --- | --- |
| Style | `full` · `minimal` | `minimal` is numbers only, `96% · 8% · warm 60m`, in a fixed order: week, 5-hour, context, cache. A cold cache shows the next message's price (`cold $4.78`). No Details card. |
| Colours | `full` · `muted` · `off` | `muted` is all grey, in Claude Code's own greys, with colour only for a low window or a full context. `off` has no colour at all, warnings in bold. |
| Show | `always` · `when it matters` | `when it matters` hides the band until a window drops under 25%, the cache goes cold, or the context passes 85%. |
| Show the dot bars | on · off | Off: `Week 96% left · resets in 6d 21h`, no dots. A low window colours the percentage instead. |
| Show the week / 5-hour window / context / cache | on · off | Leave out the parts you don't need. Only the context, for example. |
| Cache length | `auto` · `5 minutes` · `1 hour` | `auto` is 1 hour on a Claude plan and 5 minutes on an API key. Set it by hand if yours differs. The 5-minute cache is also priced at its own write rate (1.25x input). |

### Not on a Claude plan?

The band adapts instead of waiting forever for limits that never come:

- **API key:** `API key · session $1.23` instead of the plan windows, plus context and cache.
- **Cloud provider, gateway or local model** (`ANTHROPIC_BASE_URL` pointing elsewhere, Bedrock, Vertex, Foundry): `Model qwen3-coder-30b` plus context. No cache line, because a local model's cache isn't Anthropic's one-hour cache.

### Fits any width

The band measures itself before it picks a layout, so nothing gets clipped:

1. One row with full dot bars.
2. One row with short bars.
3. One small block per item.
4. Short-bar blocks that wrap onto more lines.

## What changed from the original

| Problem | Fix |
| --- | --- |
| After `/login` to another account the band kept the old usage until a new session. | The band watches the signed-in account. After a switch it clears the old figures and the old cache, then loads the new account's usage within 30 seconds, whichever session did the `/login`. |
| `USAGE · waiting for the first reply` on a new session. | On a plan, usage loads at session start from the same endpoint `/usage` reads. Nothing waits for a reply. |
| Stuck on "waiting for the first reply" with an API key or a local model. | Plan detection: API keys show session cost, local and cloud models show the model and the context. |
| `7D`, `5H`, `WARM` were hard to read at a glance. | Plain labels (`Week`, `5-hour`, `resets in`, `cold in`, `next msg`) and a `/ribbon` legend. |
| Loud orange and yellow on a fixed dark slab; dark even in a light theme ([#3](https://github.com/robonuggets/ribbon/issues/3), [#14](https://github.com/robonuggets/ribbon/issues/14)). | The band uses your theme's colours (Claude's own coral, its amber and red for warnings), so it follows light and dark. The card swaps to a light palette by itself. |
| Chip and Show button clipped between ~78 and ~112 columns ([#3](https://github.com/robonuggets/ribbon/issues/3), [#14](https://github.com/robonuggets/ribbon/issues/14)). | Layout chosen by measuring the real text. The button sits beside the band, never on it. |
| Sonnet 5.5 cache reads priced at $0.20, Haiku 5.5 always at the long-prompt rate ([#2](https://github.com/robonuggets/ribbon/pull/2), [#8](https://github.com/robonuggets/ribbon/issues/8)). | Prices checked against Anthropic's list on 2026-11-11: Fable 5.2 $8 / $0.20, Opus 5.5 $4 / $0.20, Sonnet 5.5 $2 / $0.10, Haiku 5.5 $0.10 / $0.01 up to 100K tokens. Older versions keep their own rates. |
| A resume priced re-caching from the table even when Claude Code knew better ([#7](https://github.com/robonuggets/ribbon/pull/7)). | Uses Claude Code's own `estimated_cache_write_usd` while cold. |
| Another mod's band disappeared when ribbon drew first ([#4](https://github.com/robonuggets/ribbon/pull/4)). | The other band stays and draws above ribbon. |
| Desktop app hides the context gauge ([#17](https://github.com/robonuggets/ribbon/issues/17)). | Context is part of the band. |

## Good to know

- **No tokens spent.** The band reads Claude Code's own figures. On a plan it also asks the account's usage endpoint (the one `/usage` uses) at start, after a switch, and at most every 5 minutes. That request costs no tokens.
- **The account check stays local.** To notice a switch, the band compares the account and organization ids in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`). It never shows or sends them.
- **Prices are estimates.** They come from the table in `hooks/cache-art.ts` (`MODELS`), not from your bill.
- **The cache length is a guess you can correct.** On a plan Claude Code writes the 1-hour cache; on an API key the band assumes 5 minutes. Set **Cache length** in `/config` if yours differs.
- **Subagents don't count.** Only your main chat resets the cache clock.
- **Known notice:** if a security plugin runs before ribbon and doesn't pass `SessionStart` on, Claude Code prints `ribbon: its classic.SessionStart hook was skipped` ([#22](https://github.com/robonuggets/ribbon/issues/22)). Only the resumed-session cache estimate is lost; the rest works.

## What is inside

```
ribbon/
├── .claude-plugin/
│   ├── plugin.json         the mod's name and version
│   └── marketplace.json    makes this repo installable
├── hooks/
│   ├── hooks.json          points to the module
│   ├── register.tsx        the band: usage, context, cache, account watch, layout
│   ├── account.ts          plan detection, the usage endpoint, the account fingerprint
│   ├── cache-art.ts        the cache card and robot drawings, the price table
│   └── font.ts             Outfit, embedded so the drawings render anywhere
├── types/index.d.ts        the shape of what the band remembers
└── tests/                  16 tests: layouts, plans, account switch, prices, cache
```

## Develop it

```
claude --plugin-dir ./ribbon      # load without installing
claude plugin test ./ribbon       # run the tests
claude plugin validate ./ribbon   # check what the engine will accept
```

## Remove it

```
claude plugin uninstall ribbon@kompas
```

## License

[MIT](LICENSE), like the original. The original is © Jay E | RoboNuggets.

The embedded font is [Outfit](https://github.com/Outfitio/Outfit-Fonts), under the SIL Open Font License 1.1.
