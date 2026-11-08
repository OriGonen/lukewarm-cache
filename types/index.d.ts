export type Settings = {
  message: string
  // Seconds before expiry, one for each action
  leadSeconds: number
  compactLeadSeconds: number
  maxPokes: number
  // What goes out when the cache is about to expire
  action: 'poke' | 'compact'
}

export type Limit = { kind: string; percentUsed: number }

export type Mode = 'off' | 'on' | 'stopped'

export type StopReason = 'limit' | 'cold' | 'failed' | 'interrupted' | 'lost' | 'compactFailed'

export type Core = {
  // When the main conversation last used its cache; null before any request
  lastHit: number | null
  // The TTL the transcript last reported; null until one is seen
  detectedTtlMs: number | null
  // A new session's wait for its first TTL: the deadline while it runs
  ttlWait: number | 'done' | null
  transcript: string | null
  model: string
  mode: Mode
  stopReason: StopReason
  // Pokes in a row since the last real turn
  count: number
  poke: 'none' | 'sent' | 'running' | 'compacting'
  pokeText: string
  pokeTurnId: string
  pokeSentAt: number
  isBusy: boolean
  // What emptied the cache (a compaction, /clear); pokes wait for a real message
  heldBy: string
  // Set by /lukewarm ttl for this session only; moves the countdown, not the server
  ttlOverrideMs: number | null
  isEditing: boolean
  limits: Limit[]
  settings: Settings
}

declare module 'claude-code' {
  interface PluginState {
    'lukewarm-cache': { core: Core }
  }
}
