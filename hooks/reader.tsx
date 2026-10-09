import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { ReplyComment, ReplyCommentsRelayed, ReplyCommentsView } from '../types'
import {
  commentAt,
  lastOf,
  lineOf,
  nextWord,
  offsetAt,
  paragraphAt,
  paragraphJump,
  prevWord,
  selectionRange,
  trimRange,
  wrap,
} from './lib'
import type { Line } from './lib'

/** What the hooks module hands the reader. */
export type ReaderProps = {
  reply: string
  comments: ReplyComment[]
  overall: string
  rev: number
  /** Keys pressed on the pane's legend, newest last; applied once each, by `seq`. */
  relay: ReplyCommentsRelayed[]
}

/** What the reader posts back: the whole draft and its own view, each time. */
export type ReaderPost = {
  comments: ReplyComment[]
  overall: string
  view: ReplyCommentsView
  action?: 'send' | 'fill' | 'close' | 'clear'
}

type Target = { start: number; end: number } | { overall: true } | { edit: number }

type Mode = ReplyCommentsView['mode']

type Via = ReplyCommentsView['via']

type ReaderState = {
  rev: number
  reply: string
  mode: Mode
  via: Via
  cursor: number
  anchor: number
  isDragging: boolean
  target?: Target
  draft: string
  comments: ReplyComment[]
  overall: string
  top: number
  /** The newest relayed key already applied. */
  relaySeq: number
  flash?: string
}

const FOOTER_ROWS = 1

const NAMED_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'space', 'insert',
])

// The instance's live state: handlers read it so keys pressed faster than a
// frame build on each other instead of on the last drawn state.
let live: ReaderState | undefined
let liveSurface: unknown
let lastLayout = { columns: 80, bodyRows: 10 }

const newestSeq = (relay: readonly ReplyCommentsRelayed[] | undefined) =>
  (relay ?? []).reduce((n, r) => Math.max(n, r.seq), 0)

function fresh(props: ReaderProps, prev?: ReaderState, isSameInstance = false): ReaderState {
  const sameReply = prev?.reply === props.reply
  return {
    rev: props.rev,
    reply: props.reply,
    mode: 'normal',
    via: 'reader',
    cursor: sameReply ? Math.min(prev!.cursor, Math.max(0, props.reply.length - 1)) : 0,
    anchor: 0,
    isDragging: false,
    draft: '',
    comments: props.comments,
    overall: props.overall,
    top: sameReply ? prev!.top : 0,
    relaySeq: Math.max(isSameInstance ? (prev?.relaySeq ?? 0) : 0, newestSeq(props.relay)),
  }
}

export function viewOf(s: ReaderState): ReplyCommentsView {
  const target = s.target && 'overall' in s.target ? 'overall' : s.target && 'edit' in s.target ? 'edit' : 'comment'
  return { mode: s.mode, via: s.via, target, draft: s.mode === 'comment' ? s.draft : '' }
}

const Reader: ClientModule<ReaderProps, ReaderState> = (props, surface) => {
  // The surface object is the instance: the same one comes back on every call.
  const isSameInstance = surface === liveSurface
  if (!isSameInstance || live === undefined || live.rev !== props.rev) {
    live = fresh(props, isSameInstance ? live : surface.state, isSameInstance)
    liveSurface = surface
  }

  const columns = surface.columns > 0 ? surface.columns : 80
  const bodyRows = Math.max(1, (surface.rows > 0 ? surface.rows : 12) - FOOTER_ROWS)
  lastLayout = { columns, bodyRows }

  const post = (s: ReaderState, action?: ReaderPost['action']) => {
    const data: ReaderPost = { comments: s.comments, overall: s.overall, view: viewOf(s) }
    if (action) data.action = action
    surface.post(data)
  }
  const commit = (next: ReaderState, action?: ReaderPost['action']) => {
    live = next
    surface.setState(next)
    post(next, action)
  }

  // Keys pressed on the pane's legend arrive as props: apply each new one once.
  const pending = (props.relay ?? []).filter(r => r.seq > live!.relaySeq)
  if (pending.length > 0) {
    let s = live
    let action: ReaderPost['action']
    for (const r of pending) {
      const result = r.key === 'save' ? saveRelayed(s, r.text ?? '') : onKey(s, { key: r.key }, 'pane')
      s = { ...result.state, relaySeq: r.seq }
      action = result.action ?? action
    }
    commit(s, action)
  }

  surface.onKey(event => {
    if (!live) return
    const { state, action } = onKey(live, event, 'reader')
    commit(state, action)
  })
  surface.onPointer(event => {
    if (!live) return
    const next = onPointer(live, event)
    if (next !== live) commit(next)
  })

  return draw(surface, live, columns, bodyRows)
}

export default Reader

// ---------- input ----------

type KeyResult = { state: ReaderState; action?: ReaderPost['action'] }

function linesOf(s: ReaderState): Line[] {
  return wrap(s.reply, lastLayout.columns)
}

/** Keeps the cursor's row inside the window. */
function scrolled(s: ReaderState, lines: readonly Line[]): ReaderState {
  const row = lineOf(lines, s.cursor)
  const rows = lastLayout.bodyRows
  let top = s.top
  if (row < top) top = row
  if (row >= top + rows) top = row - rows + 1
  top = Math.max(0, Math.min(top, Math.max(0, lines.length - rows)))
  return top === s.top ? s : { ...s, top }
}

function move(s: ReaderState, key: string, ctrl: boolean): number | undefined {
  const text = s.reply
  const lines = linesOf(s)
  const row = lineOf(lines, s.cursor)
  const col = s.cursor - lines[row]!.start
  const page = Math.max(1, lastLayout.bodyRows - 1)

  if (ctrl) {
    if (key === 'd' || key === 'f') return offsetAt(lines, row + page, col)
    if (key === 'u' || key === 'b') return offsetAt(lines, row - page, col)
    return undefined
  }
  switch (key) {
    case 'h':
    case 'left':
      return Math.max(lines[row]!.start, s.cursor - 1)
    case 'l':
    case 'right':
      return Math.min(lastOf(lines[row]!), s.cursor + 1)
    case 'j':
    case 'down':
      return offsetAt(lines, row + 1, col)
    case 'k':
    case 'up':
      return offsetAt(lines, row - 1, col)
    case 'w':
      return nextWord(text, s.cursor)
    case 'b':
      return prevWord(text, s.cursor)
    case 'n':
    case '}':
      return paragraphJump(text, s.cursor, 1)
    case 'p':
    case '{':
      return paragraphJump(text, s.cursor, -1)
    case 'd':
    case 'pagedown':
      return offsetAt(lines, row + page, col)
    case 'u':
    case 'pageup':
      return offsetAt(lines, row - page, col)
    case 'g':
      return 0
    case 'e':
    case 'G':
      return lastOf(lines[lines.length - 1]!)
    case '0':
    case 'home':
      return lines[row]!.start
    case '$':
    case 'end':
      return lastOf(lines[row]!)
    default:
      return undefined
  }
}

function startComment(s: ReaderState, range: { start: number; end: number }, via: Via): ReaderState {
  const r = trimRange(s.reply, range.start, range.end)
  if (r.end <= r.start) return { ...s, mode: 'normal', flash: 'Nothing selected' }
  return { ...s, mode: 'comment', via, target: r, draft: '', cursor: r.start }
}

function saveComment(s: ReaderState): KeyResult {
  const text = s.draft.trim()
  const base: ReaderState = { ...s, mode: 'normal', target: undefined, draft: '' }
  const target = s.target
  if (!target) return { state: base }

  if ('overall' in target) {
    return { state: { ...base, overall: text, flash: text ? 'Overall comment saved' : 'Overall comment removed' } }
  }
  if ('edit' in target) {
    const comments = text
      ? s.comments.map((c, i) => (i === target.edit ? { ...c, text } : c))
      : s.comments.filter((_, i) => i !== target.edit)
    return { state: { ...base, comments, flash: text ? 'Comment updated' : 'Comment removed' } }
  }
  if (!text) return { state: { ...base, flash: 'Empty comment discarded' } }

  const comment: ReplyComment = {
    start: target.start,
    end: target.end,
    quote: s.reply.slice(target.start, target.end),
    text,
  }
  const comments = [...s.comments, comment].sort((a, b) => a.start - b.start)
  return { state: { ...base, comments, flash: `Comment ${comments.length} saved` } }
}

/** The comment field in the pane sent its text. */
export function saveRelayed(s: ReaderState, text: string): KeyResult {
  if (s.mode !== 'comment') return { state: s }
  return saveComment({ ...s, draft: text })
}

function onComment(s: ReaderState, event: ClientKeyEvent): KeyResult {
  const { key } = event
  if (event.ctrl && key === 'u') return { state: { ...s, draft: '' } }
  if (event.ctrl && (key === 'c' || key === 'g')) {
    return { state: { ...s, mode: 'normal', target: undefined, draft: '', flash: 'Comment cancelled' } }
  }
  if (key === 'return' || key === 'enter') return saveComment(s)
  if (key === 'backspace' || key === 'delete') {
    if (!s.draft) return { state: { ...s, mode: 'normal', target: undefined, flash: 'Comment cancelled' } }
    return { state: { ...s, draft: [...s.draft].slice(0, -1).join('') } }
  }
  if (key === 'space') return { state: { ...s, draft: `${s.draft} ` } }
  if (event.ctrl || event.meta || NAMED_KEYS.has(key)) return { state: s }
  return { state: { ...s, draft: s.draft + key.replace(/[\r\n\t]+/g, ' ') } }
}

/** One key, from the reader's own keyboard or relayed from the pane's legend. */
export function onKey(prev: ReaderState, event: ClientKeyEvent, via: Via): KeyResult {
  const s: ReaderState = prev.flash ? { ...prev, flash: undefined } : prev
  const { key } = event
  const ctrl = event.ctrl === true

  if (s.mode === 'comment') {
    // A comment typed in the pane's field arrives whole as `save`; keys the
    // legend relays meanwhile are not text.
    return via === 'reader' ? onComment(s, event) : { state: s }
  }
  if (!s.reply) return { state: s }

  const to = move(s, key, ctrl)
  if (to !== undefined) return { state: scrolled({ ...s, cursor: to }, linesOf(s)) }
  if (ctrl) return { state: s }

  const here = commentAt(s.comments, s.cursor)
  const hasAny = s.comments.length > 0 || s.overall.trim() !== ''

  switch (key) {
    case 'v':
      return { state: s.mode === 'visual' ? { ...s, mode: 'normal' } : { ...s, mode: 'visual', anchor: s.cursor } }
    case 'a': {
      const p = paragraphAt(s.reply, s.cursor)
      if (p.end <= p.start) return { state: s }
      return { state: scrolled({ ...s, mode: 'visual', anchor: p.start, cursor: p.end - 1 }, linesOf(s)) }
    }
    case 'c':
    case 'return':
    case 'enter':
      if (s.mode === 'visual') return { state: startComment(s, selectionRange(s.reply, s.anchor, s.cursor, false), via) }
      if (here >= 0 && key !== 'c') {
        return { state: { ...s, mode: 'comment', via, target: { edit: here }, draft: s.comments[here]!.text } }
      }
      return { state: startComment(s, paragraphAt(s.reply, s.cursor), via) }
    case 'r':
      if (here < 0) return { state: { ...s, flash: 'No comment under the cursor' } }
      return { state: { ...s, mode: 'comment', via, target: { edit: here }, draft: s.comments[here]!.text } }
    case 'x':
      if (here < 0) return { state: { ...s, flash: 'No comment under the cursor' } }
      return { state: { ...s, comments: s.comments.filter((_, i) => i !== here), flash: 'Comment removed' } }
    case 'o':
      return { state: { ...s, mode: 'comment', via, target: { overall: true }, draft: s.overall } }
    case 'm': {
      if (s.comments.length === 0) return { state: { ...s, flash: 'No comments yet' } }
      const hit = s.comments.find(c => c.start > s.cursor) ?? s.comments[0]!
      return { state: scrolled({ ...s, mode: 'normal', cursor: hit.start }, linesOf(s)) }
    }
    case 's':
      if (!hasAny) return { state: { ...s, flash: 'Nothing to send yet' } }
      return { state: s, action: 'send' }
    case 'f':
      if (!hasAny) return { state: { ...s, flash: 'Nothing to put in the prompt yet' } }
      return { state: s, action: 'fill' }
    case 'z':
      return { state: s, action: 'clear' }
    case 'q':
      return { state: s, action: 'close' }
    default:
      return { state: s }
  }
}

export function onPointer(s: ReaderState, event: ClientPointerEvent): ReaderState {
  if (!s.reply || s.mode === 'comment') return s
  if (event.button !== undefined && event.button !== 'left') return s

  const lines = linesOf(s)
  const rows = lastLayout.bodyRows
  const rowAt = (y: number) => s.top + Math.max(-1, Math.min(rows, y))
  const at = (y: number, x: number) => offsetAt(lines, rowAt(y), x)

  if (event.type === 'down') {
    if (event.y >= rows) return s
    const pos = at(event.y, event.x)
    return { ...s, mode: 'visual', anchor: pos, cursor: pos, isDragging: true, flash: undefined }
  }
  if (event.type === 'move' && s.isDragging) {
    return scrolled({ ...s, cursor: at(event.y, event.x) }, lines)
  }
  if (event.type === 'up' && s.isDragging) {
    const pos = at(event.y, event.x)
    const done = { ...s, cursor: pos, isDragging: false }
    if (pos === s.anchor) return { ...done, mode: 'normal' }
    return startComment(done, selectionRange(s.reply, s.anchor, pos, false), 'reader')
  }
  return s
}

// ---------- drawing ----------

type Style = 'plain' | 'cursor' | 'selected' | 'commented'

function styleProps(style: Style) {
  switch (style) {
    case 'cursor':
      return { backgroundColor: 'cyan', color: 'black' }
    case 'selected':
      return { inverse: true }
    case 'commented':
      return { color: 'yellow', underline: true }
    default:
      return {}
  }
}

const printable = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ')

function draw(surface: ClientSurface<ReaderState>, s: ReaderState, columns: number, bodyRows: number) {
  const { Box, Text } = surface.elements

  if (!s.reply) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No reply to annotate.</Text>
      </Box>
    )
  }

  const lines = wrap(s.reply, columns)
  const top = Math.max(0, Math.min(s.top, Math.max(0, lines.length - bodyRows)))
  const sel =
    s.mode === 'visual'
      ? selectionRange(s.reply, s.anchor, s.cursor, false)
      : s.mode === 'comment' && s.target && 'start' in s.target
        ? s.target
        : undefined
  const showCursor = s.mode !== 'comment'

  const styleAt = (offset: number): Style => {
    if (showCursor && offset === s.cursor) return 'cursor'
    if (sel && offset >= sel.start && offset < sel.end) return 'selected'
    if (commentAt(s.comments, offset) >= 0) return 'commented'
    return 'plain'
  }

  const rows = lines.slice(top, top + bodyRows).map(line => {
    if (line.end === line.start) {
      return <Text {...styleProps(showCursor && s.cursor === line.start ? 'cursor' : 'plain')}> </Text>
    }
    const segments: { style: Style; text: string }[] = []
    for (let o = line.start; o < line.end; o++) {
      const style = styleAt(o)
      const last = segments[segments.length - 1]
      if (last && last.style === style) last.text += s.reply[o]
      else segments.push({ style, text: s.reply[o]! })
    }
    return (
      <Box flexDirection="row">
        {segments.map(seg => (
          <Text {...styleProps(seg.style)}>{printable(seg.text)}</Text>
        ))}
      </Box>
    )
  })
  while (rows.length < bodyRows) rows.push(<Text> </Text>)

  return (
    <Box flexDirection="column">
      {rows}
      {statusRow(surface, s, lines, top)}
    </Box>
  )
}

function statusRow(surface: ClientSurface<ReaderState>, s: ReaderState, lines: readonly Line[], top: number) {
  const { Box, Text } = surface.elements
  const label = s.mode.toUpperCase()
  const count = `${s.comments.length} comment${s.comments.length === 1 ? '' : 's'}${s.overall.trim() ? ' + overall' : ''}`
  const row = lineOf(lines, s.cursor) + 1
  const where = `${row}/${lines.length}${top + lastLayout.bodyRows < lines.length ? ' ↓' : ''}`

  return (
    <Box flexDirection="row" gap={1}>
      <Text bold inverse>{` ${label} `}</Text>
      {s.mode === 'comment' ? null : <Text>{count}</Text>}
      {s.mode === 'comment' ? null : <Text dimColor>{`line ${where}`}</Text>}
      {context(surface, s)}
    </Box>
  )
}

/** The one thing worth saying about where the reader is, after the status. */
function context(surface: ClientSurface<ReaderState>, s: ReaderState) {
  const { Text } = surface.elements

  if (s.mode === 'comment') {
    if (s.via === 'pane') return <Text dimColor wrap="truncate-end">type the comment in the field below</Text>
    const what = s.target && 'overall' in s.target ? 'overall' : s.target && 'edit' in s.target ? 'revise' : 'comment'
    return <Text wrap="truncate-start">{`${what}> ${printable(s.draft)}█ (Enter saves)`}</Text>
  }
  if (s.flash) return <Text color="green" wrap="truncate-end">{s.flash}</Text>
  if (s.mode === 'visual') return <Text dimColor wrap="truncate-end">move to extend · c comment · v cancel</Text>
  const here = commentAt(s.comments, s.cursor)
  if (here >= 0) {
    return <Text color="yellow" wrap="truncate-end">{`💬 ${printable(s.comments[here]!.text)} (r revise · x delete)`}</Text>
  }
  return null
}
