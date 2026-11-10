// Lukewarm Cache: a small prompt-cache countdown below the prompt, with a
// keep-warm toggle that pokes before the cache expires.
//
// The countdown, ring and transcript reading follow Cache TTL Timer; the poke's
// send and tracking follow Cache Caffeine (both MIT, see LICENSE).

import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderNode } from 'claude-code'

import type { Core, Settings, StopReason } from '../types'
import {
  DEFAULT_SETTINGS,
  LEAD_MAX,
  LEAD_MIN,
  POKES_MAX,
  STOP_TEXT,
  TEST_TTL_MAX,
  TEST_TTL_MIN,
  activeLead,
  cleanMessage,
  failureText,
  stopText,
  cleanSettings,
  footerText,
  labelText,
  leadMs,
  modelName,
  overLine,
  parseLead,
  parseMaxPokes,
  parseTranscript,
  parseTtlArg,
  pokeDueAt,
  pokeWasCold,
  provenTtl,
  shouldPoke,
  stopAfterPoke,
  truncate,
  ttlOf,
  ttlSource,
} from './logic'

type Engine = EngineInterface
type Field = 'message' | 'lead' | 'limit'

const INITIAL: Core = {
  lastHit: null,
  detectedTtlMs: null,
  ttlWait: null,
  transcript: null,
  model: '',
  mode: 'off',
  stopReason: 'limit',
  stopDetail: '',
  count: 0,
  poke: 'none',
  pokeText: '',
  pokeTurnId: '',
  pokeSentAt: 0,
  isBusy: false,
  heldBy: '',
  ttlOverrideMs: null,
  isEditing: false,
  limits: [],
  settings: DEFAULT_SETTINGS,
}

const core = atom({ plugin: 'lukewarm-cache', key: 'core' } as const, INITIAL)

const SETTINGS_KEY = 'settings'
// How long a new session's first request waits for its row in the transcript
const TTL_WAIT_MS = 10_000
// A sent poke whose turn hasn't begun by then is given up on
const POKE_WATCHDOG_MS = 10 * 60_000
const WARN_FRACTION = 0.2
const PROJECT_SLUG_MAX = 200
const RING_STEPS = 120
const GLYPHS = ['●', '◕', '◑', '◔', '○']
const COLD_GLYPH = '◌'
// The editor's columns, in characters; the frame is its border and padding
const EDITOR_WIDTH = 56
const EDITOR_LABEL = 22
const EDITOR_GAP = 2
const EDITOR_FRAME = 4

type Level = 'warm' | 'warn' | 'cold'
type Readout = { left: number; level: Level; step: number; label: string }

function patch($: Engine, part: Partial<Core>): Promise<unknown> {
  return update($, core, (c) => ({ ...c, ...part }))
}

async function loadSettings($: Engine): Promise<Settings> {
  return cleanSettings(await $.store.get(SETTINGS_KEY))
}

function isWaitingForTtl(c: Core): boolean {
  return c.ttlOverrideMs === null && c.detectedTtlMs === null && typeof c.ttlWait === 'number'
}

// Where the countdown stands; null before there's anything to count
function readout(c: Core, now: number): Readout | null {
  if ((c.lastHit === null && !c.heldBy) || isWaitingForTtl(c)) return null
  const total = ttlOf(c)
  const left = c.heldBy || c.lastHit === null ? 0 : c.lastHit + total - now
  const level: Level = left <= 0 ? 'cold' : left <= total * WARN_FRACTION ? 'warn' : 'warm'
  const step = left <= 0 ? 0 : Math.ceil((left / total) * RING_STEPS)
  return { left, level, step, label: labelText(left) }
}

function ringGlyph(r: Readout): string {
  if (r.level === 'cold') return COLD_GLYPH
  const emptied = 1 - r.step / RING_STEPS
  return GLYPHS[Math.min(GLYPHS.length - 1, Math.round(emptied * (GLYPHS.length - 1)))]!
}

type Keep = { tone: 'off' | 'on' | 'stopped'; text: string }

// What the toggle says now. Short, since the desktop footer holds about 24 characters.
function keepView(c: Core, r: Readout, now: number): Keep {
  if (c.mode === 'off') return { tone: 'off', text: 'keep warm?' }
  if (c.mode === 'stopped') return { tone: 'stopped', text: `stopped: ${STOP_TEXT[c.stopReason]}` }
  if (c.poke === 'compacting') return { tone: 'on', text: 'compacting…' }
  if (c.poke !== 'none') return { tone: 'on', text: 'poking…' }
  if (c.isBusy) return { tone: 'on', text: 'turn running' }
  if (overLine(c.limits)) return { tone: 'on', text: 'usage high' }
  const due = pokeDueAt(c)
  if (due === null || r.left <= 0) return { tone: 'on', text: 'waits for you' }
  const isCompact = c.settings.action === 'compact'
  if (due <= now) return { tone: 'on', text: isCompact ? 'compact due' : 'poke due' }
  return { tone: 'on', text: (isCompact ? 'compact ' : 'poke in ') + labelText(due - now) }
}

// The short line under the timer
function underLine(c: Core, columns: number): string | null {
  if (c.mode === 'stopped') {
    return c.stopDetail ? `why: ${truncate(c.stopDetail, Math.max(8, columns - 30))} · press to turn back on` : 'press to turn back on'
  }
  if (c.mode !== 'on') return null
  if (c.settings.action === 'compact') return 'compacts before the cache expires'
  const sent = c.count > 0 ? ` · ${c.count} of ${c.settings.maxPokes} sent` : ''
  return `sends "${truncate(c.settings.message, Math.max(8, Math.min(40, columns - 24)))}"${sent}`
}

// Nothing to keep warm once the cache is cold, unless keep-warm is already on
function hasToggle(keep: Keep, r: Readout): boolean {
  return keep.tone !== 'off' || r.left > 0
}

// The desktop's row. A footer button is a bubble one letter tall, always in the
// app's own color, so the words themselves are the switch, spelled with letters
// that sit on the baseline. The footer holds about 24 characters: with keep-warm
// on, the time of the next poke stands in for the countdown.
function desktopRow($: Engine, ui: ElementTable<'desktop'>, c: Core, r: Readout, now: number) {
  const { Box, Text, Button } = ui
  const keep = keepView(c, r, now)
  const test = c.ttlOverrideMs === null ? '' : '*'
  const style = r.level === 'warn' ? ({ color: 'warning' } as const) : ({ dimColor: true } as const)
  const timer = <Text {...style}>{ringGlyph(r) + ' ' + r.label + test}</Text>
  if (!hasToggle(keep, r)) return Box({ flexDirection: 'row', children: [timer] })

  // The words are the switch: pressing them turns keep-warm on or off
  const words = footerText(keep.text + (keep.tone === 'on' ? test : ''))
  const toggler = (
    <Button key="toggle" label={words} plain dimColor={keep.tone !== 'on'} onPress={() => toggle($)}>
      {words}
    </Button>
  )
  if (keep.tone === 'off') return Box({ flexDirection: 'row', columnGap: 1, children: [toggler, timer] })
  if (keep.tone === 'stopped') return Box({ flexDirection: 'row', columnGap: 1, children: [toggler] })
  const editLabel = footerText('edit poke')
  const edit = (
    <Button
      key="edit"
      label={editLabel}
      plain
      dimColor
      onPress={() => (c.isEditing ? finishEditing($) : setEditing($, true))}
    >
      {editLabel}
    </Button>
  )
  // The app colors a footer button itself, so the "on" mark is plain red text beside it
  const mark = <Text color="error">●</Text>
  return Box({ flexDirection: 'row', columnGap: 1, children: [edit, toggler, mark] })
}

function redrawKey(c: Core, now: number): string {
  const r = readout(c, now)
  return r ? r.level + r.step + r.label + keepView(c, r, now).text : ''
}

// `detail` is what the engine said, kept so the reason is still there when you come back
async function stopKeeping($: Engine, reason: StopReason, detail = ''): Promise<void> {
  await patch($, { mode: 'stopped', stopReason: reason, stopDetail: detail, poke: 'none', pokeTurnId: '' })
  $.ui.toast(`Lukewarm Cache stopped: ${stopText(reason, detail)}`)
}

async function firePoke($: Engine, c: Core, now: number): Promise<void> {
  const text = c.settings.message
  await patch($, { poke: 'sent', pokeText: text, pokeSentAt: now })
  void $.prompt.submit({ text }).catch((err: unknown) => stopKeeping($, 'failed', failureText(err)))
}

// Compacts just before expiry, while the old context is still cheap to read.
// The cache is then empty, so it holds until the next real message.
async function fireCompact($: Engine, now: number): Promise<void> {
  await patch($, { poke: 'compacting', pokeSentAt: now })
  if (!isInteractive) {
    // The desktop app, the SDK and -p refuse $.session.compact(): compaction there
    // runs inside a turn, as the /compact command. The session.compact hook settles it.
    void $.command
      .run({ command: 'compact' })
      .catch((err: unknown) => stopKeeping($, 'compactFailed', failureText(err)))
    return
  }
  // The engine leaves the calling plugin's own session.compact hook out, so it settles here
  void $.session
    .compact()
    .then((done) => settleCompact($, done))
    .catch((err: unknown) => stopKeeping($, 'compactFailed', failureText(err)))
}

async function settleCompact($: Engine, done: { skip?: string }): Promise<void> {
  if (done.skip) return stopKeeping($, 'compactFailed', failureText(done.skip))
  await patch($, { poke: 'none', lastHit: null, heldBy: 'compaction' })
}

async function toggle($: Engine): Promise<void> {
  const settings = await loadSettings($)
  await update($, core, (c) =>
    c.mode === 'on' ? { ...c, mode: 'off' as const } : { ...c, mode: 'on' as const, count: 0, settings },
  )
}

async function setEditing($: Engine, isEditing: boolean): Promise<void> {
  const settings = isEditing ? await loadSettings($) : undefined
  await update($, core, (c) => ({ ...c, isEditing, settings: settings ?? c.settings }))
}

async function saveSettings($: Engine, settings: Settings): Promise<void> {
  await $.store.set(SETTINGS_KEY, settings)
  await patch($, { settings })
}

async function setAction($: Engine, action: Settings['action']): Promise<void> {
  // Typing in the lead field belongs to the action it was typed for
  const typed = drafts.lead
  delete drafts.lead
  if (typed !== undefined) {
    const problem = await commitField($, 'lead', typed)
    if (problem) $.ui.toast(problem)
  }
  await saveSettings($, { ...(await loadSettings($)), action })
}

// Applies one field; returns what was wrong with it, or null when it's saved.
async function commitField($: Engine, field: Field, raw: string): Promise<string | null> {
  const settings = await loadSettings($)
  if (field === 'message') {
    await saveSettings($, { ...settings, message: cleanMessage(raw) })
    return null
  }
  if (field === 'lead') {
    const leadSeconds = parseLead(raw)
    if (leadSeconds === null) return `Seconds before expiry must be a whole number from ${LEAD_MIN} to ${LEAD_MAX}`
    const part = settings.action === 'compact' ? { compactLeadSeconds: leadSeconds } : { leadSeconds }
    await saveSettings($, { ...settings, ...part })
    return null
  }
  const maxPokes = parseMaxPokes(raw)
  if (maxPokes === null) return `Max pokes must be a whole number from 1 to ${POKES_MAX}`
  await saveSettings($, { ...settings, maxPokes })
  return null
}

async function hold($: Engine, by: string): Promise<void> {
  await patch($, { lastHit: null, heldBy: by })
}

async function transcriptPath($: Engine): Promise<string | null> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? home + '/.claude' : null)
  if (!config) return null
  const projects = config + '/projects/'
  const file = '/' + (await $.session.id()) + '.jsonl'
  const slug = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= PROJECT_SLUG_MAX) {
    return (await $.fs.exists(projects + slug + file)) ? projects + slug + file : null
  }
  // A longer slug is cut and given a hash suffix, so look for the folder that holds the session
  const prefix = slug.slice(0, PROJECT_SLUG_MAX) + '-'
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'dir' && entry.name.startsWith(prefix) && (await $.fs.exists(projects + entry.name + file))) {
      return projects + entry.name + file
    }
  }
  return null
}

function lastKey(sessionId: string): string {
  return 'last:' + sessionId
}

async function remember($: Engine): Promise<void> {
  const c = await read($, core)
  if (c.lastHit === null) return
  await $.store.set(lastKey(await $.session.id()), { sentAt: c.lastHit, ttlMs: c.detectedTtlMs })
}

async function learnFromTranscript($: Engine, path: string | null | undefined): Promise<void> {
  if (!path) return
  let text: string | null = null
  try {
    text = await $.fs.read(path)
  } catch {
    // Missing, or over $.fs.read's 4 MiB: the store has the last we kept
  }
  const found: { sentAt?: unknown; ttlMs?: unknown; model?: unknown } | null | undefined =
    text === null ? ((await $.store.get(lastKey(await $.session.id()))) as object | undefined) : parseTranscript(text)
  if (!found || typeof found.sentAt !== 'number') return
  const { sentAt, ttlMs, model } = found
  await update($, core, (c) => ({
    ...c,
    lastHit: Math.max(c.lastHit ?? 0, sentAt as number),
    detectedTtlMs: typeof ttlMs === 'number' ? ttlMs : c.detectedTtlMs,
    model: c.model || (typeof model === 'string' ? model : ''),
  }))
  if (text !== null) await remember($)
}

// What the ticker last drew, so it redraws only on a change
let drawnKey = ''
let isTicking = false
// A person at the prompt (the terminal); false under the desktop app, the SDK and -p
let isInteractive = true
// Typing not yet saved with Enter; the Done button applies it
let drafts: Partial<Record<Field, string>> = {}
// Set once the desktop asks for its footer; until then the row stays above the prompt
let hasFooter = false
// The status line last set. Null at load, so a line left by an older version is cleared.
let shownStatus: string | undefined | null = null

// With the row in the footer, the line about what goes out is a status line
// beside it: the Code tab draws no other text below the prompt.
function showStatus($: Engine, c: Core, now: number): void {
  const text = hasFooter && readout(c, now) ? (underLine(c, 52) ?? undefined) : undefined
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function awaitTtl($: Engine): Promise<void> {
  const c = await read($, core)
  if (typeof c.ttlWait !== 'number') return
  try {
    if (c.detectedTtlMs === null) await learnFromTranscript($, c.transcript ?? (await transcriptPath($)))
  } catch {
    // Not there yet; the next tick tries again until the deadline
  }
  const after = await read($, core)
  if (after.detectedTtlMs !== null || (await $.clock.now()) >= (after.ttlWait as number)) {
    await patch($, { ttlWait: 'done' })
  }
}

async function tick($: Engine): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    await awaitTtl($)
    const c = await read($, core)
    const now = await $.clock.now()
    if (c.poke === 'sent' && now - c.pokeSentAt > POKE_WATCHDOG_MS) {
      await stopKeeping($, 'lost')
    } else if (c.poke === 'compacting' && now - c.pokeSentAt > POKE_WATCHDOG_MS) {
      await stopKeeping($, 'compactFailed', 'it never ran')
    } else if (!isWaitingForTtl(c) && shouldPoke(c, now)) {
      if (c.settings.action === 'compact') await fireCompact($, now)
      else await firePoke($, c, now)
    }
    const latest = await read($, core)
    showStatus($, latest, now)
    const key = redrawKey(latest, now)
    if (key !== drawnKey) {
      drawnKey = key
      $.ui.invalidate('ui.render')
    }
  } finally {
    isTicking = false
  }
}

async function finishEditing($: Engine): Promise<void> {
  const pending = drafts
  drafts = {}
  for (const field of ['message', 'lead', 'limit'] as const) {
    const raw = pending[field]
    if (raw === undefined) continue
    const problem = await commitField($, field, raw)
    if (problem) $.ui.toast(problem)
  }
  await setEditing($, false)
}

async function submitField($: Engine, field: Field, raw: string): Promise<void> {
  delete drafts[field]
  $.ui.toast((await commitField($, field, raw)) ?? 'Saved')
}

async function statusText($: Engine): Promise<string> {
  const c = await read($, core)
  const now = await $.clock.now()
  const r = readout(c, now)
  const ttl = ttlOf(c)
  const head = `TTL ${Math.round(ttl / 1000)}s (${ttlSource(c)})`
  const timer = r ? (r.left > 0 ? `${labelText(r.left)} left` : 'cold') : 'no request yet'
  const isCompact = c.settings.action === 'compact'
  const mode =
    c.mode === 'stopped'
      ? `stopped: ${stopText(c.stopReason, c.stopDetail)}`
      : c.mode === 'on'
        ? isCompact
          ? 'on'
          : `on, ${c.count} of ${c.settings.maxPokes} pokes in a row`
        : 'off'
  const lead = Math.round(leadMs(activeLead(c.settings), ttl) / 1000)
  const what = isCompact ? 'compact' : `message "${c.settings.message}" · poke`
  return `${head} · ${timer} · keep-warm ${mode} · ${what} ${lead}s before expiry`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'lukewarm',
      description: 'Show the prompt cache and keep-warm state, or set a test TTL for this session',
      argumentHint: '[on|off|ttl <seconds|5m|1h|auto>]',
      immediate: true,
    })
    const started = await next(e)
    const settings = await loadSettings($)
    let limits: Core['limits'] = []
    try {
      limits = (await $.session.usage()).rateLimits.map((l) => ({ kind: l.kind, percentUsed: l.percentUsed }))
    } catch {
      // The first reply brings them
    }
    // A reload lands between turns, and whatever was in flight died with the old
    // module. Limits may not be reported yet, so an empty answer keeps the last known.
    await update($, core, (c) => ({
      ...c,
      settings,
      limits: limits.length > 0 ? limits : c.limits,
      isBusy: false,
      poke: 'none' as const,
      pokeTurnId: '',
    }))
    try {
      await learnFromTranscript($, await transcriptPath($))
    } catch {
      // No transcript yet; the first request starts the countdown
    }
    $.clock.every(1000, () => void tick($))
    return started
  })

  // Runs on startup, /resume, /clear and compaction, with the transcript's path
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) await patch($, { transcript: e.transcript_path })
    await learnFromTranscript($, e.transcript_path).catch(() => {})
    return next(e)
  })

  // Runs when Claude finishes answering: the transcript now holds the turn's cache writes
  on('classic.Stop', async ($, e, next) => {
    await learnFromTranscript($, e.transcript_path).catch(() => {})
    return next(e)
  })

  // Every main-conversation request, real or poke, restarts the TTL
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage) {
      const model = usage.model || e.model
      await update($, core, (c) => ({
        ...c,
        detectedTtlMs: provenTtl(c, sentAt, usage),
        lastHit: Math.max(c.lastHit ?? 0, sentAt),
        heldBy: '',
        model,
      }))
      await remember($)
      const c = await read($, core)
      if (c.detectedTtlMs === null && c.ttlWait === null) {
        await patch($, { ttlWait: (await $.clock.now()) + TTL_WAIT_MS })
      }
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, core, (c) =>
        c.poke === 'sent' && e.text.includes(c.pokeText)
          ? { ...c, isBusy: true, poke: 'running' as const, pokeTurnId: e.turnId }
          : { ...c, isBusy: true, count: 0 },
      )
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const c = await read($, core)
    if (c.poke !== 'running' || e.turnId !== c.pokeTurnId) {
      await patch($, { isBusy: false })
      return next(e)
    }
    const count = c.count + 1
    await patch($, { isBusy: false, poke: 'none', pokeTurnId: '', count })
    if (c.mode === 'on') {
      const reason = stopAfterPoke({
        reason: e.reason,
        isRefreshed: c.lastHit !== null && c.lastHit >= c.pokeSentAt,
        isCold: e.usage !== undefined && pokeWasCold(e.usage),
        count,
        maxPokes: c.settings.maxPokes,
      })
      if (reason) await stopKeeping($, reason)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const limits = e.rateLimits.map((l) => ({ kind: l.kind, percentUsed: l.percentUsed }))
    const c = await read($, core)
    if (JSON.stringify(limits) !== JSON.stringify(c.limits)) await patch($, { limits })
    return next(e)
  })

  // A compaction or /clear empties the cache: pokes wait for the next real request to write it
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    // Keep-warm's own /compact, where it has to run as a prompt
    const isOurs = (await read($, core)).poke === 'compacting'
    let done: Awaited<ReturnType<typeof next>>
    try {
      done = await next(e)
    } catch (err) {
      if (isOurs) await stopKeeping($, 'compactFailed', failureText(err)).catch(() => {})
      throw err
    }
    if (isOurs) await settleCompact($, done).catch(() => {})
    else if (!('skip' in done && done.skip)) await hold($, 'compaction').catch(() => {})
    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await hold($, '/clear')
    return next(e)
  })

  on('command.run', { command: 'lukewarm' }, async ($, e) => {
    const [word = '', ...rest] = (e.args ?? '').trim().split(/\s+/)
    const arg = word.toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const c = await read($, core)
      if ((arg === 'on') !== (c.mode === 'on')) await toggle($)
    } else if (arg === 'ttl') {
      const value = parseTtlArg(rest.join(' '))
      if (value === null) {
        return { text: `Use /lukewarm ttl <seconds from ${TEST_TTL_MIN} to ${TEST_TTL_MAX}>, 5m, 1h or auto` }
      }
      await patch($, { ttlOverrideMs: value === 'auto' ? null : value })
    } else if (arg && arg !== 'status') {
      return { text: 'Use /lukewarm, /lukewarm on, /lukewarm off or /lukewarm ttl <seconds|5m|1h|auto>' }
    }
    return { text: await statusText($) }
  })

  // The desktop's footer, where Cache TTL Timer drew: one short line beside the model's label
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    if (!hasFooter) {
      hasFooter = true
      $.ui.invalidate('ui.render')
    }
    const c = await read($, core)
    const now = await $.clock.now()
    const r = readout(c, now)
    if (!r) return next(e)
    const row = desktopRow($, $.ui.resolve(e), c, r, now)
    if (e.props.modes.length === 0) return row
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', children: [await next(e), <Text dimColor> · </Text>, row] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is drawn on these two; the types also allow the others
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const c = await read($, core)
    const now = await $.clock.now()
    const r = readout(c, now)
    if (!r) return next(e)
    // The footer draws the row on the desktop, but it can't hold the editor's fields
    const isInFooter = e.surface === 'desktop' && hasFooter
    if (isInFooter && !c.isEditing) return next(e)

    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const rows = []

    if (e.surface === 'desktop') {
      if (!isInFooter) rows.push(desktopRow($, $.ui.resolve(e), c, r, now))
    } else {
      const style = r.level === 'warn' ? ({ color: 'warning' } as const) : ({ dimColor: true } as const)
      // A narrow window keeps the countdown and the toggle, and drops the model's name
      const name = c.model && columns >= 44 ? modelName(c.model) + ' · ' : ''
      const test = c.ttlOverrideMs === null ? '' : ' (test TTL)'
      const keep = keepView(c, r, now)
      rows.push(
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          columnGap: 1,
          children: [
            <Text {...style}>{ringGlyph(r)}</Text>,
            <Text {...style}>{name + r.label + test}</Text>,
            !hasToggle(keep, r) ? null : keep.tone === 'off' ? (
              <Button key="toggle" label={keep.text} plain dimColor onPress={() => toggle($)}>
                {keep.text}
              </Button>
            ) : (
              <Button key="toggle" label={keep.text} plain onPress={() => toggle($)}>
                <Text color={keep.tone === 'on' ? 'success' : 'warning'}>{keep.text}</Text>
              </Button>
            ),
            keep.tone !== 'on' ? null : (
              <Button
                key="edit"
                label="edit poke"
                plain
                dimColor
                onPress={() => (c.isEditing ? finishEditing($) : setEditing($, true))}
              >
                edit poke
              </Button>
            ),
          ],
        }),
      )
    }

    const under = isInFooter || c.isEditing ? null : underLine(c, columns)
    if (under) rows.push(<Text dimColor>{under}</Text>)

    if (c.isEditing) {
      const { action } = c.settings
      const isPoke = action === 'poke'
      const lead = activeLead(c.settings)
      const used = Math.round(leadMs(lead, ttlOf(c)) / 1000)
      // One column of labels and one of controls, so every field lines up
      const isDesktop = e.surface === 'desktop'
      const width = Math.min(columns, EDITOR_WIDTH)
      const controlWidth = Math.max(10, width - EDITOR_LABEL - EDITOR_GAP - (isDesktop ? EDITOR_FRAME : 0))
      const line = (label: string, control: RenderNode) =>
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          columnGap: EDITOR_GAP,
          children: [
            Box({ width: EDITOR_LABEL, children: [<Text dimColor>{label}</Text>] }),
            Box({ width: controlWidth, children: [control] }),
          ],
        })
      const field = (key: Field, value: string, extra: { placeholder?: string; autoFocus?: true } = {}) => (
        <Input
          key={key}
          value={value}
          {...extra}
          onInput={(text) => {
            drafts[key] = text
          }}
          onSubmit={(text) => void submitField($, key, text)}
        />
      )
      const choice = (option: Settings['action']) => {
        const text = (option === action ? '● ' : '○ ') + option
        return (
          <Button key={'action-' + option} label={text} plain dimColor={option !== action} onPress={() => setAction($, option)}>
            {text}
          </Button>
        )
      }
      const lines = [line('When due', Box({ flexDirection: 'row', columnGap: 1, children: [choice('poke'), choice('compact')] }))]
      if (isPoke) {
        lines.push(
          line('Poke message', field('message', c.settings.message, { placeholder: DEFAULT_SETTINGS.message, autoFocus: true })),
        )
      }
      lines.push(line('Seconds before expiry', field('lead', String(lead))))
      if (isPoke) lines.push(line('Max pokes in a row', field('limit', String(c.settings.maxPokes))))
      const foot = [
        <Button key="done" label="done" plain onPress={() => finishEditing($)}>
          done
        </Button>,
      ]
      if (used !== lead) foot.unshift(<Text dimColor>{`capped at ${used}s for this TTL`}</Text>)
      lines.push(Box({ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', columnGap: 2, children: foot }))
      rows.push(
        Box({
          flexDirection: 'column',
          rowGap: isDesktop ? 1 : 0,
          width,
          ...(isDesktop ? ({ borderStyle: 'round', paddingX: 1 } as const) : {}),
          children: lines,
        }),
      )
    }

    return Box({ flexDirection: 'column', alignItems: 'flex-end', width: columns, children: rows })
  })
}
