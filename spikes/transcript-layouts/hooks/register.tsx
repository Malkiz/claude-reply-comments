import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SpikeCursor } from '../types'

type $ = EngineInterface

const MARKS = ['​', '‌', '‍', '⁠']

const active = atom({ plugin: 'tcursor-spike', key: 'active' } as const, false)
const cursor = atom({ plugin: 'tcursor-spike', key: 'cursor' } as const, { id: '', off: 0 } as SpikeCursor)
const keysDrawn = atom({ plugin: 'tcursor-spike', key: 'keysDrawn' } as const, MARKS[0]!)
const status = atom({ plugin: 'tcursor-spike', key: 'status' } as const, '')

type Msg = { id: string; kind: string; text: string; seq: number; onScreen: unknown }
const msgs = new Map<string, Msg>()
let seq = 0
let bandId = ''
let columns = 80
let keyAt = 0
let latency = -1
let pending = ''
let keyLog: string[] = []
let scrollNote = ""
let overlay = false
let lastAssistant = ''
const consumed = new Map<string, number>()

type Line = { start: number; end: number }

function wrap(text: string, width: number): Line[] {
  const lines: Line[] = []
  let i = 0
  for (const para of text.split('\n')) {
    if (para.length === 0) lines.push({ start: i, end: i })
    for (let p = 0; p < para.length; p += width) lines.push({ start: i + p, end: i + Math.min(para.length, p + width) })
    i += para.length + 1
  }
  return lines
}

const lineOf = (lines: Line[], off: number) => {
  for (let n = lines.length - 1; n >= 0; n--) if (off >= lines[n]!.start) return n
  return 0
}

const ordered = () => [...msgs.values()].sort((a, b) => a.seq - b.seq)
const width = () => Math.max(20, columns - 8)

function move(c: SpikeCursor, key: string): SpikeCursor {
  const list = ordered()
  if (list.length === 0) return c
  let at = list.findIndex(m => m.id === c.id)
  if (at < 0) at = list.length - 1
  const msg = list[at]!
  const lines = wrap(msg.text, width())
  const n = lineOf(lines, c.off)
  const col = c.off - lines[n]!.start
  const to = (m: Msg, line: number) => {
    const ls = wrap(m.text, width())
    const l = ls[Math.max(0, Math.min(ls.length - 1, line < 0 ? ls.length + line : line))]!
    return { id: m.id, off: Math.min(l.start + col, Math.max(l.start, l.end - 1)) }
  }
  switch (key) {
    case 'j':
      if (n + 1 < lines.length) return to(msg, n + 1)
      return at + 1 < list.length ? to(list[at + 1]!, 0) : c
    case 'k':
      if (n > 0) return to(msg, n - 1)
      return at > 0 ? to(list[at - 1]!, -1) : c
    case 'l':
      return { ...c, off: Math.min(msg.text.length - 1, c.off + 1) }
    case 'h':
      return { ...c, off: Math.max(0, c.off - 1) }
    case 'G':
      return { id: list[list.length - 1]!.id, off: 0 }
    case 'g':
      return { id: list[0]!.id, off: 0 }
    case '}':
      return at + 1 < list.length ? { id: list[at + 1]!.id, off: 0 } : c
    case '{':
      return at > 0 ? { id: list[at - 1]!.id, off: 0 } : c
  }
  return c
}

async function onKey($: $, key: string) {
  if (key === 'q') {
    await update($, active, () => false)
    return
  }
  if (key === 'g' && pending !== 'g') {
    pending = 'g'
    return
  }
  pending = ''
  keyAt = Date.now()
  const before = await read($, cursor)
  const next = move(before, key)
  await update($, cursor, () => next)
  if (next.id && next.id !== before.id) {
    const r = await $.ui.scroll({ to: { requestId: next.id }, block: 'nearest' })
    scrollNote = (`scroll ${'deny' in r && r.deny ? `denied: ${r.deny}` : 'ok'}`)
  }
}

async function onKeysTyped($: $, value: string) {
  const mark = MARKS.includes(value[0] ?? '') ? value[0]! : ''
  const body = [...(mark ? value.slice(1) : value)]
  const done = consumed.get(mark) ?? 0
  const typed = body.slice(done)
  consumed.set(mark, body.length)
  if (typed.length === 0) return
  await update($, keysDrawn, cur => {
    const next = MARKS[(MARKS.indexOf(cur) + 1) % MARKS.length]!
    consumed.set(next, 0)
    return next
  })
  keyLog = [...keyLog.slice(-7), ...typed.map(k => `b:${k}`)]
  for (const k of typed) await onKey($, k)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tcursor', description: 'Spike: vim cursor on the transcript' })
    await $.command.register({ name: 'tkeys', description: 'Spike: thin key pane' })
    await $.command.register({ name: 'tfull', description: 'Spike: widest pane' })
    await $.command.register({ name: 'tover', description: 'Spike: overlay' })
    return next(e)
  })

  on('command.run', { command: 'tcursor' }, async $ => {
    const list = ordered()
    await update($, cursor, c => (c.id && msgs.has(c.id) ? c : { id: list[list.length - 1]?.id ?? '', off: 0 }))
    await update($, active, () => true)
    void $.clock.after(300, async () => {
      if (!bandId) {
        await update($, status, () => 'no band id yet')
        return
      }
      const r = await $.ui.focus({ requestId: bandId, key: 'keys' }).catch(err => ({ deny: String(err) }))
      await update($, status, () => `focus ${'deny' in r && r.deny ? `denied: ${r.deny}` : 'ok'}`)
    })
    return { text: `tcursor: ${list.length} messages seen` }
  })

  on('command.run', { command: 'tover' }, async $ => {
    overlay = !overlay
    $.ui.invalidate('ui.render')
    return { text: `overlay ${overlay}` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'tover' } }, async ($, e, next) => {
    if (!overlay) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const vr = e.viewport?.rows ?? 40
    const vc = e.viewport?.columns ?? 120
    const pad = (s: string) => (s + ' '.repeat(vc)).slice(0, vc - 2)
    return (
      <Box flexDirection="column">
        <Text>overlay anchor</Text>
        <Box position="absolute" bottom={0} left={0} width={vc} height={vr} flexDirection="column">
          {Array.from({ length: vr }, (_, n) => (
            <Text>{pad(n === 0 ? `scroll=${JSON.stringify(e.props.onScreen)}` : `OVERLAY row ${n} ${'x'.repeat(40)}`)}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  for (const component of ['AssistantMessage', 'UserMessage'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      const text = e.props.text
      const seen = msgs.get(e.requestId)
      msgs.set(e.requestId, { id: e.requestId, kind: component, text, seq: seen?.seq ?? ++seq, onScreen: e.props.onScreen })
      if (e.viewport?.columns) columns = e.viewport.columns
      const mySeq = msgs.get(e.requestId)!.seq
      if (component === 'AssistantMessage' && mySeq >= (msgs.get(lastAssistant)?.seq ?? 0)) lastAssistant = e.requestId
      if (overlay && e.requestId === lastAssistant && false) {
        const { Box, Text } = $.ui.resolve(e)
        const vr = e.viewport?.rows ?? 40
        const vc = e.viewport?.columns ?? 120
        return (
          <Box flexDirection="column">
            <Text>{text.slice(0, 60)}</Text>
            <Box position="absolute" bottom={0} left={-2} width={vc} height={vr} flexDirection="column" backgroundColor="blue" borderStyle="round">
              {Array.from({ length: vr - 2 }, (_, n) => (
                <Text>{`OVERLAY row ${n} ${'x'.repeat(60)}`}</Text>
              ))}
            </Box>
          </Box>
        )
      }
      if (!(await read($, active))) return next(e)
      const c = await read($, cursor)
      const { Box, Text } = $.ui.resolve(e)
      const lines = wrap(text, width())
      const mine = c.id === e.requestId
      if (mine && keyAt) {
        latency = Date.now() - keyAt
        keyAt = 0
      }
      const marker = component === 'UserMessage' ? '> ' : '⏺ '
      return (
        <Box flexDirection="column" marginTop={1}>
          {lines.map((l, n) => {
            const s = text.slice(l.start, l.end)
            const lead = <Text dimColor={component === 'UserMessage'}>{n === 0 ? marker : '  '}</Text>
            if (!mine || c.off < l.start || c.off >= Math.max(l.end, l.start + 1)) {
              return (
                <Box flexDirection="row" height={1}>
                  {lead}
                  <Text>{s || ' '}</Text>
                </Box>
              )
            }
            const at = c.off - l.start
            return (
              <Box flexDirection="row" height={1}>
                {lead}
                <Text>{s.slice(0, at)}</Text>
                <Text backgroundColor="cyan" color="black">
                  {s[at] ?? ' '}
                </Text>
                <Text>{s.slice(at + 1)}</Text>
              </Box>
            )
          })}
        </Box>
      )
    })
  }

  on('command.run', { command: 'tkeys' }, async ($, e) => {
    const list = ordered()
    await update($, cursor, c => (c.id && msgs.has(c.id) ? c : { id: list[list.length - 1]?.id ?? '', off: 0 }))
    await update($, active, () => true)
    const r = await $.ui.open({ id: 'tkeys', title: 'keys', closeOnEscape: true, holdToasts: true, rows: 2, columns: 30 })
    void $.clock.after(300, async () => {
      const f = await $.ui.open({ id: 'tkeys', title: 'keys', focus: true, closeOnEscape: true, holdToasts: true, rows: 2, columns: 30 })
      scrollNote = `open ${JSON.stringify(f)}`
      await update($, status, () => 'opened')
    })
    return { text: `tkeys: fullscreen=${JSON.stringify(e.presentation)} open=${JSON.stringify(r)}` }
  })

  on('ui.close', { requestId: 'tkeys' }, async ($, e, next) => {
    if (e.origin.kind === 'person' && (await read($, active))) {
      keyLog = [...keyLog.slice(-7), 'ESC']
      await update($, status, () => keyLog.join(' '))
      void $.clock.after(80, () => $.ui.focus({ requestId: 'tkeys', key: 'keys' }).catch(() => ({})))
      return { deny: 'annotating' }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'tkeys' }, async ($, e) => {
    const { Box, Input, Text } = $.ui.resolve(e)
    const drawn = await read($, keysDrawn)
    const c = await read($, cursor)
    await read($, status)
    const list = ordered()
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{`${list.findIndex(m => m.id === c.id) + 1}/${list.length} ${e.props.placement} ${e.props.bodyColumns}`}</Text>
        <Input key="keys" label="" value={drawn} autoFocus onInput={value => onKeysTyped($, value)} onSubmit={() => onKey($, 'j')} />
      </Box>
    )
  })

  on('command.run', { command: 'tfull' }, async ($, e) => {
    const r = await $.ui.open({ id: 'tfull', title: 'full', closeOnEscape: true, holdToasts: true, columns: 500 })
    return { text: `tfull: open=${JSON.stringify(r)}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'tfull' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{`bodyColumns ${e.props.bodyColumns} viewport ${e.viewport?.columns}x${e.viewport?.rows} rows ${e.props.scroll.bodyRows}`}</Text>
      </Box>
    )
  })

  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    keyLog = [...keyLog.slice(-7), `focus:${e.element ?? 'none'}`]
    await update($, status, () => keyLog.join(" "))
    if (e.element === undefined && (await read($, active))) return { deny: 'annotating' }
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    if (!(await read($, active))) return next(e)
    const k = e.key
    const name = k ? `${k.ctrl ? 'C-' : ''}${k.meta ? 'M-' : ''}${k.key}` : `[${JSON.stringify(e.inputText)} ${e.start}-${e.end}]`
    keyLog = [...keyLog.slice(-7), `p:${name}`]
    await update($, status, () => keyLog.join(" "))
    if (k && !k.ctrl && !k.meta && k.key.length === 1) await onKey($, k.key)
    return { text: e.text, cursor: e.cursor }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandId = e.requestId
    if (!(await read($, active))) return next(e)
    const { Box, Input, Text } = $.ui.resolve(e)
    const drawn = await read($, keysDrawn)
    const st = await read($, status)
    const c = await read($, cursor)
    const list = ordered()
    const at = list.findIndex(m => m.id === c.id)
    return (
      <Box flexDirection="column">
        <Box height={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {`msg ${at + 1}/${list.length} off ${c.off} · ${st} · render ${latency}ms · ${scrollNote}`}
          </Text>
        </Box>
        <Input key="keys" label="keys" value={drawn} autoFocus onInput={value => onKeysTyped($, value)} onSubmit={() => onKey($, "j")} />
      </Box>
    )
  })
}
