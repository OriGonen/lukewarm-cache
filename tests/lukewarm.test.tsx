import { describe, expect, mock, test } from 'claude-code/testing'

import { provenTtl } from '../hooks/logic'
import type { Core } from '../types'

const START = Date.parse('2026-11-08T10:00:00Z')
const MIN = 60_000
const POKE = 'poke, just say okay'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} }
const WARM = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' }
const COLD = { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 }

type World = {
  clock: any
  submitted: string[]
  toasts: string[]
  transcript: { text: string | null }
  store: Record<string, unknown>
  compacts: { count: number }
  status: { text: string | undefined }
  limits: { value: object[] }
}

function world(on: any, opts: { store?: Record<string, unknown>; rateLimits?: object[]; compactSkip?: string } = {}): World {
  const clock = mock.clock(on, { now: START })
  const store: Record<string, unknown> = { ...opts.store }
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, { HOME: '/Users/test' })
  const submitted: string[] = []
  const toasts: string[] = []
  const transcript: { text: string | null } = { text: null }
  const compacts = { count: 0 }
  const status: { text: string | undefined } = { text: undefined }
  const limits = { value: opts.rateLimits ?? [] }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'lukewarm' } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', () => ({ value: transcript.text !== null }))
  on('fs.read', () => ({ value: transcript.text ?? '' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.usage', () => ({ value: { startedAt: START, context: { tokens: 1, window: 2, percent: 50 }, rateLimits: limits.value } }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('session.compact', (_$: any, e: any) => {
    if (e.trigger === 'manual') return { messages: e.messages }
    compacts.count++
    return opts.compactSkip ? { skip: opts.compactSkip } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: WARM }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    status.text = e.text
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  return { clock, submitted, toasts, transcript, store, compacts, status, limits }
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
}

const run = ($: any, args: string) =>
  $.command.run({ command: 'lukewarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

async function step($: any, id: string) {
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })) {
    // nothing streams
  }
}

async function turn($: any, id: string, text: string, usage: object = WARM, reason = 'answer') {
  await $.turn.start({ text, turnId: id })
  await step($, id)
  await $.turn.complete({ answer: 'okay', durationMs: 900, isAborted: reason === 'aborted', turnId: id, reason, usage })
}

function band($: any, surface: 'terminal' | 'desktop', props: object = BAND) {
  return $.ui.mount({ plugin: 'lukewarm-cache', surface, component: 'AbovePrompt', props })
}

function footer($: any, modes: string[] = []) {
  return $.ui.mount({ plugin: 'lukewarm-cache', surface: 'desktop', component: 'SessionMode', props: { modes } })
}

// Where each surface draws the row
function rowOn($: any, surface: 'terminal' | 'desktop') {
  return surface === 'desktop' ? footer($) : band($, surface)
}

async function textOf(ui: any, pattern: RegExp): Promise<string | undefined> {
  return (await ui.find({ type: 'Text', text: pattern }))?.text
}

// The line about what goes out: under the row on the terminal, and on the
// desktop a status line the next tick sets (so this moves the clock a second)
async function underLineOn(w: World, $: any, surface: 'terminal' | 'desktop'): Promise<string | undefined> {
  if (surface === 'desktop') {
    const row = await footer($)
    await row.unmount()
    await w.clock.advance(1_000)
    return w.status.text
  }
  const ui = await band($, surface)
  const text = await textOf(ui, /^(sends|compacts|press)/)
  await ui.unmount()
  return text
}

async function toggleLabel(ui: any): Promise<string | undefined> {
  return (await ui.find({ key: 'toggle' }))?.props.label
}

// The words beside the desktop's dot
async function statusOf(ui: any): Promise<string | undefined> {
  return textOf(ui, /keep warm|^poke|^compact|^stopped|^turn running|^usage high|^waits for/)
}

// A short countdown, a first real reply, and the toggle pressed
async function warmedUp($: any, ttl = 'ttl 120') {
  await start($)
  await run($, ttl)
  await turn($, 't1', 'fix the tests')
  const ui = await footer($)
  await ui.press({ key: 'toggle' })
  await ui.unmount()
}

const COMPACT = { message: POKE, leadSeconds: 60, compactLeadSeconds: 60, maxPokes: 3, action: 'compact' }

describe('lukewarm-cache', () => {
  test('draws nothing before the first reply', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await rowOn($, surface)
      expect(await ui.find({ key: 'toggle' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('off by default: the countdown, a grey "keep warm?", and no message', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    for (const surface of SURFACES) {
      const ui = await rowOn($, surface)
      const toggle = await ui.find({ key: 'toggle' })
      expect(toggle?.props.label).toBe(surface === 'desktop' ? '○' : 'keep warm?')
      expect(toggle?.props.dimColor).toBe(true)
      await ui.unmount()
      expect(await underLineOn(w, $, surface)).toBeUndefined()
    }
    const terminal = await band($, 'terminal')
    expect(await textOf(terminal, /Opus 5\.5/)).toBe('Opus 5.5 · 60m (test TTL)')
    await terminal.unmount()
    const desktop = await footer($)
    expect(await textOf(desktop, /60m/)).toBe('● 60m*')
    expect(await statusOf(desktop)).toBe('keep warm?')
    await desktop.unmount()
  })

  test('the desktop row sits in the footer, in shapes the footer can draw', async ($, on) => {
    world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    const ui = await footer($)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
    const above = await band($, 'desktop')
    expect(await above.find({ key: 'toggle' })).toBeUndefined()
    await above.unmount()
  })

  test('every footer button fits the bubble: a dot, and letters on the baseline', async ($, on) => {
    world(on)
    await warmedUp($)
    const ui = await footer($)
    expect(await toggleLabel(ui)).toBe('●')
    const edit = (await ui.find({ key: 'edit' }))?.props.label
    expect(edit).toBe('edit ᴘoke')
    expect(edit).not.toMatch(/[gjpqy]/)
    await ui.press({ key: 'toggle' })
    expect(await toggleLabel(ui)).toBe('○')
    await ui.unmount()
  })

  for (const surface of SURFACES) {
    test(`${surface}: edit poke shows only while keep-warm is on`, async ($, on) => {
      world(on)
      await start($)
      await run($, 'ttl 1h')
      await turn($, 't1', 'hello')
      const ui = await rowOn($, surface)
      expect(await ui.find({ key: 'edit' })).toBeUndefined()
      await ui.press({ key: 'toggle' })
      expect((await ui.find({ key: 'edit' }))?.props.label).toBe(surface === 'desktop' ? 'edit ᴘoke' : 'edit poke')
      await ui.press({ key: 'toggle' })
      expect(await ui.find({ key: 'edit' })).toBeUndefined()
      await ui.unmount()
    })

    test(`${surface}: no "keep warm?" once the cache is cold, until it is warm again`, async ($, on) => {
      const w = world(on)
      await start($)
      await run($, 'ttl 120')
      await turn($, 't1', 'hello')
      await w.clock.advance(121_000)
      const cold = await rowOn($, surface)
      expect(await cold.find({ key: 'toggle' })).toBeUndefined()
      expect(await cold.find({ key: 'edit' })).toBeUndefined()
      await cold.unmount()
      await turn($, 't2', 'back again')
      const warm = await rowOn($, surface)
      expect(await warm.find({ key: 'toggle' })).toBeDefined()
      await warm.unmount()
    })

    test(`${surface}: already on stays pressable after the cache goes cold`, async ($, on) => {
      const w = world(on)
      await warmedUp($)
      await $.turn.start({ text: 'a long one', turnId: 't2' })
      await w.clock.advance(130_000)
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
      const ui = await rowOn($, surface)
      expect(await ui.find({ key: 'toggle' })).toBeDefined()
      expect(await ui.find({ key: 'edit' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('stays above the prompt if the desktop never asks for its footer', async ($, on) => {
    world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    const ui = await band($, 'desktop')
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.unmount()
  })

  test('keeps the footer labels the app put there', async ($, on) => {
    world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    const ui = await footer($, ['Auto'])
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    expect(await textOf(ui, /^ · $/)).toBe(' · ')
    await ui.unmount()
  })

  test('the terminal draws a glyph for the ring', async ($, on) => {
    world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    const terminal = await band($, 'terminal')
    expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
    expect(await textOf(terminal, /^●$/)).toBe('●')
    await terminal.unmount()
  })

  test('on: green with the next poke and the message beneath', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await w.clock.advance(18_000)
    const terminal = await band($, 'terminal')
    const label = await terminal.find({ type: 'Text', text: /^poke in/ })
    expect(label?.text).toBe('poke in 0:42')
    expect(label?.props.color).toBe('success')
    await terminal.unmount()
    expect(await underLineOn(w, $, 'terminal')).toBe(`sends "${POKE}"`)
    const desktop = await footer($)
    expect(await statusOf(desktop)).toBe('poke in 0:42*')
    expect((await desktop.find({ type: 'Text', text: /^poke in/ }))?.props.color).toBe('success')
    await desktop.unmount()
    expect(await underLineOn(w, $, 'desktop')).toBe(`sends "${POKE}"`)
  })

  test('on: the dot is the off switch, and the message line clears', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    expect(await underLineOn(w, $, 'desktop')).toBe(`sends "${POKE}"`)
    const ui = await footer($)
    expect(await statusOf(ui)).toMatch(/^poke in/)
    await ui.press({ key: 'toggle' })
    expect(await statusOf(ui)).toBe('keep warm?')
    await ui.unmount()
    expect(await underLineOn(w, $, 'desktop')).toBeUndefined()
  })

  test('a poke goes out at TTL minus the lead, as a framed turn of its own', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await w.clock.advance(59_000)
    expect(w.submitted).toEqual([])
    await w.clock.advance(2_000)
    expect(w.submitted).toEqual([POKE])
    // Only one while it waits to begin
    await w.clock.advance(10_000)
    expect(w.submitted).toEqual([POKE])
  })

  test('real activity pushes the next poke back and clears the count', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await w.clock.advance(61_000)
    await turn($, 'p1', POKE)
    expect(await underLineOn(w, $, 'desktop')).toContain('1 of 3 sent')
    await w.clock.advance(30_000)
    await turn($, 't2', 'a real question')
    expect(await underLineOn(w, $, 'desktop')).not.toContain('of 3 sent')
    await w.clock.advance(58_000)
    expect(w.submitted).toEqual([POKE])
    await w.clock.advance(2_000)
    expect(w.submitted).toEqual([POKE, POKE])
  })

  test('never pokes while a turn is running', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await $.turn.start({ text: 'a long one', turnId: 't2' })
    await w.clock.advance(100_000)
    expect(w.submitted).toEqual([])
    const ui = await footer($)
    expect(await statusOf(ui)).toBe('turn running*')
    await ui.unmount()
  })

  test('does not poke once the cache has expired', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await $.turn.start({ text: 'a long one', turnId: 't2' })
    await w.clock.advance(130_000)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(5_000)
    expect(w.submitted).toEqual([])
  })

  test('stops after the limit and says so, until pressed again', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    for (let i = 1; i <= 3; i++) {
      await w.clock.advance(61_000)
      expect(w.submitted.length).toBe(i)
      await turn($, 'p' + i, POKE)
    }
    await w.clock.advance(61_000)
    expect(w.submitted.length).toBe(3)
    expect(w.toasts).toContain('Lukewarm Cache stopped: limit reached')
    const terminal = await band($, 'terminal')
    const label = await terminal.find({ type: 'Text', text: /^stopped/ })
    expect(label?.text).toBe('stopped: limit reached')
    expect(label?.props.color).toBe('warning')
    await terminal.unmount()
    const ui = await footer($)
    expect(await statusOf(ui)).toBe('stopped: limit reached')
    expect(await ui.find({ key: 'edit' })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await statusOf(ui)).toContain('poke')
    await ui.unmount()
  })

  test('stops when a poke came back cold', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await w.clock.advance(61_000)
    await turn($, 'p1', POKE, COLD)
    const ui = await footer($)
    expect(await statusOf(ui)).toBe('stopped: cache was cold')
    await ui.unmount()
  })

  test('stops when a poke is interrupted', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await w.clock.advance(61_000)
    await turn($, 'p1', POKE, WARM, 'aborted')
    const ui = await footer($)
    expect(await statusOf(ui)).toBe('stopped: interrupted')
    await ui.unmount()
  })

  test('pauses near a usage limit', async ($, on) => {
    const w = world(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 95 }] })
    await warmedUp($)
    await w.clock.advance(61_000)
    expect(w.submitted).toEqual([])
    const ui = await footer($)
    expect(await statusOf(ui)).toBe('usage high*')
    await ui.unmount()
  })

  test('a compaction holds pokes until a real message', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    await $.session.compact({ messages: [{ role: 'user', text: 'x', toolUses: [] }], trigger: 'manual' } as never)
    await w.clock.advance(61_000)
    expect(w.submitted).toEqual([])
    await turn($, 't2', 'carry on')
    await w.clock.advance(61_000)
    expect(w.submitted).toEqual([POKE])
  })

  test('compact mode: compacts once instead of poking, then waits for a real message', async ($, on) => {
    const w = world(on, { store: { settings: COMPACT } })
    await warmedUp($)
    await w.clock.advance(18_000)
    const early = await footer($)
    expect(await statusOf(early)).toBe('compact 0:42*')
    await early.unmount()
    expect(await underLineOn(w, $, 'desktop')).toBe('compacts before the cache expires')

    await w.clock.advance(42_000)
    expect(w.compacts.count).toBe(1)
    expect(w.submitted).toEqual([])
    await w.clock.advance(180_000)
    expect(w.compacts.count).toBe(1)
    const after = await footer($)
    expect(await statusOf(after)).toBe('waits for you*')
    await after.unmount()

    await turn($, 't2', 'carry on')
    await w.clock.advance(61_000)
    expect(w.compacts.count).toBe(2)
    expect(w.submitted).toEqual([])
  })

  test('compact mode: a vetoed compaction stops and says so', async ($, on) => {
    const w = world(on, { store: { settings: COMPACT }, compactSkip: 'not now' })
    await warmedUp($)
    await w.clock.advance(61_000)
    expect(w.compacts.count).toBe(1)
    expect(w.toasts).toContain('Lukewarm Cache stopped: compact failed')
    await w.clock.advance(120_000)
    expect(w.compacts.count).toBe(1)
  })

  test('the pencil edits and saves the message, lead and limit', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    const row = await footer($)
    await row.press({ key: 'edit' })
    await row.unmount()
    const ui = await band($, 'desktop')
    await ui.input({ key: 'message', text: '  hi  ' })
    await ui.input({ key: 'lead', text: '30' })
    await ui.input({ key: 'limit', text: '5' })
    expect(w.store.settings).toEqual({ message: 'hi', leadSeconds: 30, compactLeadSeconds: 180, maxPokes: 5, action: 'poke' })
    await ui.press({ key: 'done' })
    expect(await ui.find({ key: 'message' })).toBeUndefined()
    await ui.unmount()
    expect(await underLineOn(w, $, 'desktop')).toBe('sends "hi"')
    await w.clock.advance(88_000)
    expect(w.submitted).toEqual([])
    await w.clock.advance(2_000)
    expect(w.submitted).toEqual(['hi'])
  })

  test('the editor switches to compacting, which drops the poke-only fields', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    const row = await footer($)
    await row.press({ key: 'edit' })
    await row.unmount()
    const ui = await band($, 'desktop')
    expect((await ui.find({ key: 'action-poke' }))?.props.label).toBe('● poke')
    expect((await ui.find({ key: 'action-compact' }))?.props.label).toBe('○ compact')
    await ui.press({ key: 'action-compact' })
    expect((w.store.settings as { action: string }).action).toBe('compact')
    expect((await ui.find({ key: 'action-compact' }))?.props.label).toBe('● compact')
    expect(await ui.find({ key: 'message' })).toBeUndefined()
    expect(await ui.find({ key: 'limit' })).toBeUndefined()
    expect(await ui.find({ key: 'lead' })).toBeDefined()
    await ui.unmount()
  })

  test('compacting defaults to 3 minutes before, apart from the poke lead', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, 'ttl 1h')
    await turn($, 't1', 'hello')
    const row = await footer($)
    await row.press({ key: 'toggle' })
    await row.press({ key: 'edit' })
    await row.unmount()
    const ui = await band($, 'desktop')
    expect((await ui.find({ key: 'lead' }))?.props.value).toBe('60')
    await ui.press({ key: 'action-compact' })
    expect((await ui.find({ key: 'lead' }))?.props.value).toBe('180')
    expect((await run($, '')).text).toContain('compact 180s before expiry')
    await ui.input({ key: 'lead', text: '240' })
    expect((w.store.settings as { compactLeadSeconds: number }).compactLeadSeconds).toBe(240)
    expect((w.store.settings as { leadSeconds: number }).leadSeconds).toBe(60)
    await ui.press({ key: 'action-poke' })
    expect((await ui.find({ key: 'lead' }))?.props.value).toBe('60')
    await ui.unmount()
  })

  test('settings saved before the compact lead existed get 3 minutes', async ($, on) => {
    world(on, { store: { settings: { message: POKE, leadSeconds: 60, maxPokes: 3, action: 'compact' } } })
    await start($)
    await run($, 'ttl 1h')
    expect((await run($, '')).text).toContain('compact 180s before expiry')
  })

  test('the editor lines fields up: no label or save button inside a field', async ($, on) => {
    world(on)
    await warmedUp($)
    const row = await footer($)
    await row.press({ key: 'edit' })
    await row.unmount()
    const ui = await band($, 'desktop')
    for (const key of ['message', 'lead', 'limit']) {
      const field = await ui.find({ key })
      expect(field?.props.label).toBeUndefined()
      expect(field?.props.submitLabel).toBeUndefined()
    }
    expect(await textOf(ui, /^Seconds before expiry$/)).toBe('Seconds before expiry')
    await ui.unmount()
  })

  test('refuses a bad lead and keeps the old one', async ($, on) => {
    const w = world(on)
    await warmedUp($)
    const row = await footer($)
    await row.press({ key: 'edit' })
    await row.unmount()
    const ui = await band($, 'desktop')
    await ui.input({ key: 'lead', text: 'soon' })
    expect(w.toasts.some((t) => t.startsWith('Seconds before expiry'))).toBe(true)
    expect(w.store.settings).toBeUndefined()
    await ui.unmount()
  })

  test('settings saved before the compact option still poke, and the toggle stays off', async ($, on) => {
    const w = world(on, { store: { settings: { message: 'still here', leadSeconds: 20, maxPokes: 7 } } })
    await start($)
    await run($, 'ttl 120')
    await turn($, 't1', 'hello')
    const ui = await footer($)
    expect((await ui.find({ key: 'toggle' }))?.props.dimColor).toBe(true)
    await ui.press({ key: 'toggle' })
    await ui.unmount()
    expect(await underLineOn(w, $, 'desktop')).toBe('sends "still here"')
    expect((await run($, '')).text).toContain('poke 20s before expiry')
  })

  test('takes the TTL from the transcript, including a longer one', async ($, on) => {
    const w = world(on)
    const row = (written: object) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(START).toISOString(),
        message: { id: 'm1', model: 'claude-opus-5-5', usage: { ...WARM, cache_creation: written } },
      })
    w.transcript.text = row({ ephemeral_2h_input_tokens: 100, ephemeral_5m_input_tokens: 0 })
    await start($)
    expect((await run($, '')).text).toContain('TTL 7200s (detected)')
    const ui = await band($, 'terminal')
    expect(await textOf(ui, /Opus 5\.5/)).toBe('Opus 5.5 · 120m')
    await ui.unmount()
  })

  test('a cache read after more than 5 minutes shows the TTL is 1 hour', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 't1', 'hello')
    expect((await run($, '')).text).toContain('TTL 300s (estimated from your plan)')
    await w.clock.advance(6 * MIN)
    await turn($, 't2', 'still cached', WARM)
    expect((await run($, '')).text).toContain('TTL 3600s (detected)')
  })

  test('only a warm request after a long gap counts as proof of the 1 hour TTL', () => {
    const known = { detectedTtlMs: null, lastHit: START } as Core
    const after = START + 6 * MIN
    expect(provenTtl(known, after, WARM)).toBe(60 * MIN)
    expect(provenTtl(known, after, COLD)).toBeNull()
    expect(provenTtl(known, after, { ...COLD, cache_read_input_tokens: 15_000 })).toBeNull()
    expect(provenTtl(known, START + 4 * MIN, WARM)).toBeNull()
    expect(provenTtl({ ...known, lastHit: null }, after, WARM)).toBeNull()
    expect(provenTtl({ ...known, detectedTtlMs: 5 * MIN }, after, WARM)).toBe(5 * MIN)
  })

  test('a reload that gets no limits keeps the ones it knew', async ($, on) => {
    const w = world(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] })
    await start($)
    expect((await run($, '')).text).toContain('TTL 3600s (estimated from your plan)')
    w.limits.value = []
    await start($)
    expect((await run($, '')).text).toContain('TTL 3600s (estimated from your plan)')
  })

  test('a narrow terminal drops the model and keeps the rest', async ($, on) => {
    world(on)
    await warmedUp($)
    const ui = await band($, 'terminal', { ...BAND, bodyColumns: 40 })
    expect(await textOf(ui, /Opus/)).toBeUndefined()
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.unmount()
  })

  test('steps aside for a survey', async ($, on) => {
    world(on)
    await warmedUp($)
    const ui = await band($, 'terminal', { ...BAND, hasSurvey: true })
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    await ui.unmount()
  })

  test('/lukewarm ttl refuses a value out of range', async ($, on) => {
    world(on)
    await start($)
    expect((await run($, 'ttl 5')).text).toContain('Use /lukewarm ttl')
  })
})
