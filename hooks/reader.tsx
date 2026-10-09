import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { ReplyComment, ReplyCommentsRelayed, ReplyCommentsView } from '../types'
import { commentAt, lineOf, offsetAt, searchMatches, selectionRange, wrap } from './lib'
import type { Line } from './lib'
import { escape, initialState, scrollBy, scrolled, selection, step, submitInput, viewOf } from './vim'
import type { Action, Layout, StepResult, VimState } from './vim'

/** What the hooks module hands the reader. */
export type ReaderProps = {
  reply: string
  comments: ReplyComment[]
  overall: string
  rev: number
  /** Keys typed in the pane's key field, newest last; applied once each, by `seq`. */
  relay: ReplyCommentsRelayed[]
}

/** What the reader posts back: the whole draft and its own view, each time. */
export type ReaderPost = {
  comments: ReplyComment[]
  overall: string
  view: ReplyCommentsView
  action?: Action
}

type ReaderState = VimState & { relaySeq: number; isDragging: boolean }

/** The status row under the text. */
const FOOTER_ROWS = 1

// The instance's live state: handlers read it so keys pressed faster than a
// frame build on each other instead of on the last drawn state.
let live: ReaderState | undefined
let liveSurface: unknown
let layout: Layout = { columns: 80, rows: 10 }

const newestSeq = (relay: readonly ReplyCommentsRelayed[] | undefined) =>
  (relay ?? []).reduce((n, r) => Math.max(n, r.seq), 0)

function fresh(props: ReaderProps, prev: ReaderState | undefined, isSameInstance: boolean): ReaderState {
  const base = initialState(props.reply, props.comments, props.overall, props.rev)
  const keep = prev !== undefined && prev.reply === props.reply
  return {
    ...base,
    cursor: keep ? Math.min(prev.cursor, Math.max(0, props.reply.length - 1)) : 0,
    top: keep ? prev.top : 0,
    search: keep ? prev.search : '',
    relaySeq: Math.max(isSameInstance ? (prev?.relaySeq ?? 0) : 0, newestSeq(props.relay)),
    isDragging: false,
  }
}

/** Applies one step to the reader's state, keeping its own fields. */
const apply = (s: ReaderState, r: StepResult): { state: ReaderState; action?: Action } => ({
  state: { ...s, ...r.state },
  action: r.action,
})

const Reader: ClientModule<ReaderProps, ReaderState> = (props, surface) => {
  // The surface object is the instance: the same one comes back on every call.
  const isSameInstance = surface === liveSurface
  if (!isSameInstance || live === undefined || live.rev !== props.rev) {
    live = fresh(props, isSameInstance ? live : surface.state, isSameInstance)
    liveSurface = surface
  }

  const columns = surface.columns > 0 ? surface.columns : 80
  const rows = Math.max(1, (surface.rows > 0 ? surface.rows : 12) - FOOTER_ROWS)
  layout = { columns, rows }

  const commit = (next: ReaderState, action?: Action) => {
    live = next
    surface.setState(next)
    const data: ReaderPost = { comments: next.comments, overall: next.overall, view: viewOf(next) }
    if (action) data.action = action
    surface.post(data)
  }

  // Keys typed in the pane's key field arrive as props: apply each new one once.
  const pending = (props.relay ?? []).filter(r => r.seq > live!.relaySeq)
  if (pending.length > 0) {
    let s = live
    let action: Action | undefined
    for (const r of pending) {
      const result =
        r.key === 'submit'
          ? apply(s, submitInput(s, r.text ?? '', layout))
          : r.key === 'escape'
            ? { state: { ...s, ...escape(s) } }
            : r.key === 'wheel'
              ? { state: { ...s, ...scrollBy(s, layout, Number(r.text) || 0) } }
            : apply(s, step(s, { key: r.key }, 'pane', layout))
      s = { ...result.state, relaySeq: r.seq }
      action = result.action ?? action
    }
    commit(s, action)
  }

  surface.onKey(event => {
    if (!live) return
    const result = apply(live, step(live, event, 'reader', layout))
    commit(result.state, result.action)
  })
  surface.onPointer(event => {
    if (!live) return
    const next = onPointer(live, event)
    if (next !== live) commit(next)
  })

  return draw(surface, live, columns, rows)
}

export default Reader

// ---------- mouse ----------

export function onPointer(s: ReaderState, event: ClientPointerEvent): ReaderState {
  if (!s.reply || s.mode === 'input') return s
  if (event.button !== undefined && event.button !== 'left') return s

  const lines = wrap(s.reply, layout.columns)
  const rowAt = (y: number) => s.top + Math.max(-1, Math.min(layout.rows, y))
  const at = (y: number, x: number) => offsetAt(lines, rowAt(y), x)

  if (event.type === 'down') {
    if (event.y >= layout.rows) return s
    const pos = at(event.y, event.x)
    return { ...s, mode: 'visual', pending: '', anchor: pos, cursor: pos, want: -1, isDragging: true, flash: undefined }
  }
  if (event.type === 'move' && s.isDragging) {
    return { ...s, ...scrolled({ ...s, cursor: at(event.y, event.x) }, layout, lines) }
  }
  if (event.type === 'up' && s.isDragging) {
    const pos = at(event.y, event.x)
    const done: ReaderState = { ...s, cursor: pos, isDragging: false }
    if (pos === s.anchor) return { ...done, mode: 'normal' }
    const r = selectionRange(s.reply, s.anchor, pos, false)
    if (r.end <= r.start) return { ...done, mode: 'normal' }
    return { ...done, mode: 'input', inputKind: 'comment', via: 'reader', target: r, draft: '', cursor: r.start }
  }
  return s
}

// ---------- drawing ----------

type Style = 'plain' | 'cursor' | 'selected' | 'commented' | 'match'

function styleProps(style: Style) {
  switch (style) {
    case 'cursor':
      return { backgroundColor: 'cyan', color: 'black' }
    case 'selected':
      return { inverse: true }
    case 'commented':
      return { color: 'yellow', underline: true }
    case 'match':
      return { color: 'cyan', underline: true }
    default:
      return {}
  }
}

const printable = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ')

function draw(surface: ClientSurface<ReaderState>, s: ReaderState, columns: number, rows: number) {
  const { Box, Text } = surface.elements

  if (!s.reply) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No reply to annotate.</Text>
      </Box>
    )
  }

  const lines = wrap(s.reply, columns)
  const top = Math.max(0, Math.min(s.top, Math.max(0, lines.length - rows)))
  const sel = selection(s)
  const showCursor = s.mode !== 'input'
  const visible = lines.slice(top, top + rows)
  const from = visible[0]?.start ?? 0
  const to = visible[visible.length - 1]?.end ?? 0
  const matchLen = s.search.length
  const matches = searchMatches(s.reply, s.search).filter(at => at + matchLen > from && at < to)

  const styleAt = (offset: number): Style => {
    if (showCursor && offset === s.cursor) return 'cursor'
    if (sel && offset >= sel.start && offset < sel.end) return 'selected'
    if (commentAt(s.comments, offset) >= 0) return 'commented'
    if (matches.some(at => offset >= at && offset < at + matchLen)) return 'match'
    return 'plain'
  }

  // Every row is exactly one cell tall, so nothing below it ever moves.
  const textRows = visible.map(line => {
    if (line.end === line.start) {
      return (
        <Box height={1} overflow="hidden">
          <Text {...styleProps(showCursor && s.cursor === line.start ? 'cursor' : 'plain')}> </Text>
        </Box>
      )
    }
    const segments: { style: Style; text: string }[] = []
    for (let o = line.start; o < line.end; o++) {
      const style = styleAt(o)
      const last = segments[segments.length - 1]
      if (last && last.style === style) last.text += s.reply[o]
      else segments.push({ style, text: s.reply[o]! })
    }
    return (
      <Box flexDirection="row" height={1} overflow="hidden">
        {segments.map(seg => (
          <Text {...styleProps(seg.style)} wrap="truncate-end">
            {printable(seg.text)}
          </Text>
        ))}
      </Box>
    )
  })
  while (textRows.length < rows) {
    textRows.push(
      <Box height={1}>
        <Text dimColor>~</Text>
      </Box>,
    )
  }

  return (
    <Box flexDirection="column">
      {textRows}
      {statusRow(surface, s, lines, top, rows)}
    </Box>
  )
}

const MODE_LABEL: Record<VimState['mode'], string> = {
  normal: 'NORMAL',
  visual: 'VISUAL',
  vline: 'V-LINE',
  input: 'INPUT',
}

function statusRow(surface: ClientSurface<ReaderState>, s: ReaderState, lines: readonly Line[], top: number, rows: number) {
  const { Box, Text } = surface.elements
  const label =
    s.mode !== 'input'
      ? MODE_LABEL[s.mode]
      : s.inputKind === 'comment'
        ? 'COMMENT'
        : s.inputKind === 'search'
          ? 'SEARCH'
          : 'COMMAND'
  const count = `${s.comments.length} comment${s.comments.length === 1 ? '' : 's'}${s.overall.trim() ? ' + overall' : ''}`
  const where = `${lineOf(lines, s.cursor) + 1}/${lines.length}${top + rows < lines.length ? ' ↓' : ''}`
  const prefix = s.inputKind === 'search' ? '/' : s.inputKind === 'command' ? ':' : '> '

  let info = ''
  let color: string | undefined
  if (s.mode === 'input') {
    info = s.via === 'pane' ? 'type below · Enter finishes · Esc cancels' : `${prefix}${printable(s.draft)}█`
  } else if (s.flash) {
    info = s.flash
    color = 'green'
  } else {
    const here = commentAt(s.comments, s.cursor)
    if (here >= 0) {
      info = `💬 ${printable(s.comments[here]!.text)}`
      color = 'yellow'
    }
  }
  const right = s.mode === 'input' ? '' : `${s.pending ? `${s.pending}  ` : ''}${count} · ${where}`

  return (
    <Box flexDirection="row" height={1} overflow="hidden" gap={1}>
      <Text bold inverse>{` ${label} `}</Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text color={color} dimColor={!color && s.mode === 'input' && s.via === 'pane'} wrap="truncate-end">
          {info || ' '}
        </Text>
      </Box>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
}
