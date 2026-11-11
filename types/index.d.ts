/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request (clock milliseconds), how much context the next request re-sends,
 * the model's context window, and the model. `usd` is Claude Code's own
 * re-cache estimate on a resume, used while it still applies.
 */
export type CacheFacts = { lastAt: number; tokens: number; window: number; model: string | null; usd?: number }

/** Whether the cache card is open, remembered only for the state it was set in. */
export type Fold = { mode: 'warm' | 'cold'; open: boolean }

/** How the session pays: a claude.ai plan, an API key, or anything else (cloud, gateway, local model). */
export type Plan = 'subscription' | 'api' | 'other'

/**
 * What the band knows about the account: how it pays, whether a reply has come
 * back since the session (or the account) started, and the session's cost so far.
 */
export type Account = { plan: Plan; replied: boolean; usd?: number }

declare module 'claude-code' {
  interface PluginState {
    'ribbon': { windows: Window[]; cache: CacheFacts | null; fold: Fold | null; account: Account | null }
  }
}
