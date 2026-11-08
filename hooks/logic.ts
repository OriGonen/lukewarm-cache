// The parts of Lukewarm Cache with no engine in them: labels, the transcript,
// the TTL, and the rules for when a poke goes out or keep-warm stops.
//
// labelText, parseTranscript and the ring come from Cache TTL Timer (MIT,
// Seongje Hong); pokeWasCold, ttlByPlan and overLine are adapted from Cache
// Caffeine (MIT, Luis Perez Morales). See LICENSE.

import type { Core, Limit, Settings, StopReason } from '../types'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export const TTL_5M = 5 * MINUTE
export const TTL_1H = HOUR

export const DEFAULT_SETTINGS: Settings = {
  message: 'poke, just say okay',
  leadSeconds: 60,
  compactLeadSeconds: 180,
  maxPokes: 3,
  action: 'poke',
}
export const LEAD_MIN = 5
export const LEAD_MAX = 3570
export const POKES_MAX = 50
export const MESSAGE_MAX = 500
export const TEST_TTL_MIN = 30
export const TEST_TTL_MAX = 3600

// Where pokes pause: the same lines Cache Caffeine stops at
const LIMIT_LINE: Record<string, number> = { five_hour: 90, seven_day: 95 }

export const STOP_TEXT: Record<StopReason, string> = {
  limit: 'limit reached',
  cold: 'cache was cold',
  failed: 'poke failed',
  interrupted: 'interrupted',
  lost: 'poke never ran',
  compactFailed: 'compact failed',
}

// 47m while there's time, 0:42 in the last minute
export function labelText(left: number): string {
  if (left <= 0) return 'Cold'
  if (left < MINUTE) return '0:' + String(Math.ceil(left / SECOND)).padStart(2, '0')
  return Math.ceil(left / MINUTE) + 'm'
}

// The desktop footer clips its buttons to one letter's height, in the app's own
// styles, which cuts off anything below the baseline. These look-alikes sit on it.
const SITS_ON_BASELINE: Record<string, string> = { g: 'ɢ', p: 'ᴘ', y: 'ʏ' }

export function footerText(text: string): string {
  return text.replace(/[gpy]/g, (letter) => SITS_ON_BASELINE[letter]!)
}

// claude-opus-5-5 -> Opus 5.5; claude-3-5-sonnet-20241022 -> Sonnet 3.5
export function modelName(id: string): string {
  const parts = id
    .replace(/\[.*$/, '')
    .replace(/^.*?claude-/, '')
    .split('-')
  const family = parts.find((p) => /^[a-z]/i.test(p))
  if (!family) return id
  const version = parts.filter((p) => /^\d{1,2}$/.test(p)).join('.')
  const name = family[0]!.toUpperCase() + family.slice(1)
  return version ? name + ' ' + version : name
}

// The TTL a usage row wrote at, whatever the API calls it (ephemeral_1h_...,
// ephemeral_5m_..., and any longer one it adds later); null when it wrote none.
function writtenTtlMs(written: Record<string, unknown>): number | null {
  let longest: number | null = null
  for (const [key, tokens] of Object.entries(written)) {
    const match = /^ephemeral_(\d+)(m|h|d)_input_tokens$/.exec(key)
    if (!match || typeof tokens !== 'number' || tokens <= 0) continue
    const unit = match[2] === 'm' ? MINUTE : match[2] === 'h' ? HOUR : 24 * HOUR
    const ms = Number(match[1]) * unit
    if (longest === null || ms > longest) longest = ms
  }
  return longest
}

export type Found = { sentAt: number; ttlMs: number | null; model: string | null }

// From transcript lines: when the last main-conversation request was sent, the
// TTL of the latest cache write, and the model it ran on.
export function parseTranscript(text: string): Found | null {
  let sentAt: number | null = null
  let ttlMs: number | null = null
  let model: string | null = null
  let lastUserAt: number | null = null
  let lastId: unknown = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      // A line still being written
      continue
    }
    if (row.isSidechain) continue
    const at = Date.parse(row.timestamp)
    if (Number.isNaN(at)) continue
    // A prompt or a tool result is written just before the request that carries it
    if (row.type === 'user') {
      lastUserAt = at
      continue
    }
    if (row.type !== 'assistant') continue
    const message = row.message ?? {}
    const usage = message.usage
    if (!usage || message.model === '<synthetic>') continue
    // One response is written as several rows that share its id
    if (message.id !== lastId) {
      lastId = message.id
      sentAt = lastUserAt ?? at
    }
    if (typeof message.model === 'string') model = message.model
    ttlMs = writtenTtlMs(usage.cache_creation ?? {}) ?? ttlMs
  }
  return sentAt === null ? null : { sentAt, ttlMs, model }
}

// With no write seen yet: 1h on a subscription under its limits, else 5m (an
// API key reports no limits, and a full window bills overage at 5m).
export function ttlByPlan(limits: readonly Limit[]): number {
  return limits.length > 0 && limits.every((l) => l.percentUsed < 100) ? TTL_1H : TTL_5M
}

export function ttlOf(c: Core): number {
  return c.ttlOverrideMs ?? c.detectedTtlMs ?? ttlByPlan(c.limits)
}

export function ttlSource(c: Core): string {
  if (c.ttlOverrideMs !== null) return 'test override, this session only'
  return c.detectedTtlMs !== null ? 'detected' : 'estimated from your plan'
}

// A transcript over 4 MiB can't be read, so the TTL it records stays unknown.
// But a warm request more than 5 minutes after the last one shows the cache
// outlived 5 minutes, which means the 1 hour TTL. A small read alone proves
// nothing: other sessions can keep the shared start of the prompt cached.
export function provenTtl(
  c: Core,
  sentAt: number,
  usage: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): number | null {
  if (c.detectedTtlMs !== null || c.lastHit === null || pokeWasCold(usage)) return c.detectedTtlMs
  if ((usage.cache_read_input_tokens ?? 0) <= 0) return null
  return sentAt - c.lastHit > TTL_5M ? TTL_1H : null
}

export function overLine(limits: readonly Limit[]): boolean {
  return limits.some((l) => {
    const line = LIMIT_LINE[l.kind]
    return line !== undefined && l.percentUsed >= line
  })
}

// How long before expiry the poke goes out. A lead as long as the TTL would
// poke straight after every reply, so it's capped: at least 30 seconds (half
// the TTL, for a short test TTL) always pass before a poke.
export function leadMs(leadSeconds: number, ttl: number): number {
  return Math.min(leadSeconds * SECOND, Math.max(ttl - 30 * SECOND, ttl / 2))
}

// The seconds before expiry that apply to the chosen action
export function activeLead(settings: Settings): number {
  return settings.action === 'compact' ? settings.compactLeadSeconds : settings.leadSeconds
}

export function pokeDueAt(c: Core): number | null {
  if (c.lastHit === null || c.heldBy) return null
  const ttl = ttlOf(c)
  return c.lastHit + ttl - leadMs(activeLead(c.settings), ttl)
}

// Everything that has to be true for a poke to go out now.
export function shouldPoke(c: Core, now: number): boolean {
  if (c.mode !== 'on' || c.poke !== 'none' || c.isBusy || overLine(c.limits)) return false
  const due = pokeDueAt(c)
  if (due === null || now < due) return false
  // Past expiry a poke would only write the whole cache again
  return now < c.lastHit! + ttlOf(c)
}

// Wrote more than it read: most of the context went back into the cache. A
// warm poke writes only the last reply and itself.
export function pokeWasCold(usage: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): boolean {
  return (usage.cache_creation_input_tokens ?? 0) > (usage.cache_read_input_tokens ?? 0)
}

// Why keep-warm stops after a finished poke; null when it carries on.
export function stopAfterPoke(args: {
  reason: string
  isRefreshed: boolean
  isCold: boolean
  count: number
  maxPokes: number
}): StopReason | null {
  if (args.reason === 'aborted') return 'interrupted'
  // Without a fresh request the countdown never moved, and the next tick would poke again
  if (args.reason !== 'answer' || !args.isRefreshed) return 'failed'
  if (args.isCold) return 'cold'
  return args.count >= args.maxPokes ? 'limit' : null
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

export function parseLead(value: unknown): number | null {
  const n = wholeNumber(value)
  return n !== null && n >= LEAD_MIN && n <= LEAD_MAX ? n : null
}

export function parseMaxPokes(value: unknown): number | null {
  const n = wholeNumber(value)
  return n !== null && n >= 1 && n <= POKES_MAX ? n : null
}

export function cleanMessage(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().slice(0, MESSAGE_MAX) : ''
  return text || DEFAULT_SETTINGS.message
}

// What the store held, made safe: anything unusable falls back to the default.
export function cleanSettings(value: unknown): Settings {
  const v = (value ?? {}) as Partial<Record<keyof Settings, unknown>>
  return {
    message: cleanMessage(v.message),
    leadSeconds: parseLead(v.leadSeconds) ?? DEFAULT_SETTINGS.leadSeconds,
    compactLeadSeconds: parseLead(v.compactLeadSeconds) ?? DEFAULT_SETTINGS.compactLeadSeconds,
    maxPokes: parseMaxPokes(v.maxPokes) ?? DEFAULT_SETTINGS.maxPokes,
    action: v.action === 'compact' ? 'compact' : 'poke',
  }
}

// /lukewarm ttl: 90 (seconds), 5m, 1h or auto. A number in ms, 'auto', or null if unusable.
export function parseTtlArg(arg: string): number | 'auto' | null {
  const text = arg.trim().toLowerCase()
  if (text === 'auto') return 'auto'
  const match = /^(\d+)\s*(s|m|h)?$/.exec(text)
  if (!match) return null
  const seconds = Number(match[1]) * (match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1)
  return seconds >= TEST_TTL_MIN && seconds <= TEST_TTL_MAX ? seconds * SECOND : null
}

export function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : line.slice(0, Math.max(1, max - 1)) + '…'
}
