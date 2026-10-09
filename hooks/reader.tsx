import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { ReplyComment } from '../types'
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
}

/** What the reader posts back: the whole draft each time, and what to do with it. */
export type ReaderPost = {
  comments: ReplyComment[]
  overall: string
  action?: 'send' | 'fill' | 'close'
}

type Target = { start: number; end: number } | { overall: true } | { edit: number }

type Mode = 'normal' | 'visual' | 'comment' | 'help'

type ReaderState = {
  rev: number
  reply: string
  mode: Mode
  cursor: number
  anchor: number
  linewise: boolean
  isDragging: boolean
  target?: Target
  draft: string
  comments: ReplyComment[]
  overall: string
  top: number
  flash?: string
}

const FOOTER_ROWS = 2

const NAMED_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'space', 'insert',
])

const HELP = [
  'Move      h j k l / arrows · w b words · 0 $ line · { } paragraphs',
  '          g G top/bottom · ctrl+d ctrl+u half page · n N next/prev comment',
  'Select    drag with the mouse, or v (chars) / V (lines), then c or Enter',
  '          p comments the whole paragraph under the cursor',
  'Comment   type, Enter saves, Backspace on an empty draft cancels, ctrl+u clears',
  'Manage    e edit · x delete the comment under the cursor · o overall comment',
  'Finish    s send all as one prompt · f put it in the prompt box · q close',
  '',
  'Esc gives the keyboard back to Claude Code; click the text to take it again.',
  'Press any key to close this help.',
]

// The instance's live state: handlers read it so keys pressed faster than a
// frame build on each other instead of on the last drawn state.
let live: ReaderState | undefined
let lastLayout = { columns: 80, bodyRows: 10 }

function fresh(props: ReaderProps, prev?: ReaderState): ReaderState {
  const sameReply = prev?.reply === props.reply
  return {
    rev: props.rev,
    reply: props.reply,
    mode: 'normal',
    cursor: sameReply ? Math.min(prev!.cursor, Math.max(0, props.reply.length - 1)) : 0,
    anchor: 0,
    linewise: false,
    isDragging: false,
    draft: '',
    comments: props.comments,
    overall: props.overall,
    top: sameReply ? prev!.top : 0,
  }
}

const Reader: ClientModule<ReaderProps, ReaderState> = (props, surface) => {
  if (surface.state === undefined || live === undefined || live.rev !== props.rev) {
    live = fresh(props, surface.state ?? live)
  }

  const columns = surface.columns > 0 ? surface.columns : 80
  const bodyRows = Math.max(1, (surface.rows > 0 ? surface.rows : 12) - FOOTER_ROWS)
  lastLayout = { columns, bodyRows }

  const commit = (next: ReaderState) => {
    live = next
    surface.setState(next)
  }
  const post = (s: ReaderState, action?: ReaderPost['action']) => {
    const data: ReaderPost = { comments: s.comments, overall: s.overall }
    if (action) data.action = action
    surface.post(data)
  }

  surface.onKey(event => {
    if (!live) return
    const { state, posted } = onKey(live, event)
    commit(state)
    if (posted) post(state, posted.action)
  })
  surface.onPointer(event => {
    if (!live) return
    commit(onPointer(live, event))
  })

  return draw(surface, live, columns, bodyRows)
}

export default Reader

// ---------- input ----------

type KeyResult = { state: ReaderState; posted?: { action?: ReaderPost['action'] } }

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
  const half = Math.max(1, Math.floor(lastLayout.bodyRows / 2))

  if (ctrl) {
    if (key === 'd') return offsetAt(lines, row + half, col)
    if (key === 'u') return offsetAt(lines, row - half, col)
    if (key === 'f') return offsetAt(lines, row + lastLayout.bodyRows, col)
    if (key === 'b') return offsetAt(lines, row - lastLayout.bodyRows, col)
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
    case '0':
    case 'home':
      return lines[row]!.start
    case '$':
    case 'end':
      return lastOf(lines[row]!)
    case 'g':
      return 0
    case 'G':
      return lastOf(lines[lines.length - 1]!)
    case '}':
      return paragraphJump(text, s.cursor, 1)
    case '{':
      return paragraphJump(text, s.cursor, -1)
    case 'pagedown':
      return offsetAt(lines, row + lastLayout.bodyRows, col)
    case 'pageup':
      return offsetAt(lines, row - lastLayout.bodyRows, col)
    default:
      return undefined
  }
}

function startComment(s: ReaderState, range: { start: number; end: number }): ReaderState {
  const r = trimRange(s.reply, range.start, range.end)
  if (r.end <= r.start) return { ...s, mode: 'normal', flash: 'Nothing selected' }
  return { ...s, mode: 'comment', target: r, draft: '', cursor: r.start }
}

function saveComment(s: ReaderState): KeyResult {
  const text = s.draft.trim()
  const base: ReaderState = { ...s, mode: 'normal', target: undefined, draft: '' }
  const target = s.target
  if (!target) return { state: base }

  if ('overall' in target) {
    return { state: { ...base, overall: text, flash: text ? 'Overall comment saved' : 'Overall comment removed' }, posted: {} }
  }
  if ('edit' in target) {
    const comments = text
      ? s.comments.map((c, i) => (i === target.edit ? { ...c, text } : c))
      : s.comments.filter((_, i) => i !== target.edit)
    return { state: { ...base, comments, flash: text ? 'Comment updated' : 'Comment removed' }, posted: {} }
  }
  if (!text) return { state: { ...base, flash: 'Empty comment discarded' } }

  const comment: ReplyComment = {
    start: target.start,
    end: target.end,
    quote: s.reply.slice(target.start, target.end),
    text,
  }
  const comments = [...s.comments, comment].sort((a, b) => a.start - b.start)
  return { state: { ...base, comments, flash: `Comment ${comments.length} saved` }, posted: {} }
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

export function onKey(prev: ReaderState, event: ClientKeyEvent): KeyResult {
  const s: ReaderState = prev.flash ? { ...prev, flash: undefined } : prev
  const { key } = event
  const ctrl = event.ctrl === true

  if (s.mode === 'help') return { state: { ...s, mode: 'normal' } }
  if (s.mode === 'comment') return onComment(s, event)
  if (!s.reply) return { state: s }

  const to = move(s, key, ctrl)
  if (to !== undefined) return { state: scrolled({ ...s, cursor: to }, linesOf(s)) }
  if (ctrl) return { state: s }

  if (s.mode === 'visual') {
    switch (key) {
      case 'c':
      case 'a':
      case 'i':
      case 'return':
      case 'enter':
        return { state: startComment(s, selectionRange(s.reply, s.anchor, s.cursor, s.linewise)) }
      case 'o':
        return { state: scrolled({ ...s, anchor: s.cursor, cursor: s.anchor }, linesOf(s)) }
      case 'v':
        return { state: s.linewise ? { ...s, linewise: false } : { ...s, mode: 'normal' } }
      case 'V':
        return { state: s.linewise ? { ...s, mode: 'normal' } : { ...s, linewise: true } }
      case 'q':
        return { state: { ...s, mode: 'normal' } }
      default:
        return { state: s }
    }
  }

  const here = commentAt(s.comments, s.cursor)
  switch (key) {
    case 'v':
      return { state: { ...s, mode: 'visual', anchor: s.cursor, linewise: false } }
    case 'V':
      return { state: { ...s, mode: 'visual', anchor: s.cursor, linewise: true } }
    case 'p':
      return { state: startComment(s, paragraphAt(s.reply, s.cursor)) }
    case 'return':
    case 'enter':
    case 'e':
      if (here >= 0) {
        return { state: { ...s, mode: 'comment', target: { edit: here }, draft: s.comments[here]!.text } }
      }
      return key === 'e'
        ? { state: { ...s, flash: 'No comment under the cursor' } }
        : { state: startComment(s, paragraphAt(s.reply, s.cursor)) }
    case 'x':
    case 'd':
      if (here < 0) return { state: { ...s, flash: 'No comment under the cursor' } }
      return {
        state: { ...s, comments: s.comments.filter((_, i) => i !== here), flash: 'Comment removed' },
        posted: {},
      }
    case 'o':
      return { state: { ...s, mode: 'comment', target: { overall: true }, draft: s.overall } }
    case 'n':
    case 'N': {
      const list = key === 'n' ? s.comments.filter(c => c.start > s.cursor) : s.comments.filter(c => c.start < s.cursor)
      const hit = key === 'n' ? list[0] : list[list.length - 1]
      if (!hit) return { state: { ...s, flash: s.comments.length ? 'No more comments that way' : 'No comments yet' } }
      return { state: scrolled({ ...s, cursor: hit.start }, linesOf(s)) }
    }
    case 's':
      if (s.comments.length === 0 && !s.overall.trim()) return { state: { ...s, flash: 'Nothing to send yet' } }
      return { state: s, posted: { action: 'send' } }
    case 'f':
      if (s.comments.length === 0 && !s.overall.trim()) return { state: { ...s, flash: 'Nothing to put in the prompt yet' } }
      return { state: s, posted: { action: 'fill' } }
    case 'q':
      return { state: s, posted: { action: 'close' } }
    case '?':
      return { state: { ...s, mode: 'help' } }
    default:
      return { state: s }
  }
}

export function onPointer(s: ReaderState, event: ClientPointerEvent): ReaderState {
  if (!s.reply || s.mode === 'comment' || s.mode === 'help') return s
  if (event.button !== undefined && event.button !== 'left') return s

  const lines = linesOf(s)
  const rows = lastLayout.bodyRows
  const rowAt = (y: number) => s.top + Math.max(-1, Math.min(rows, y))
  const at = (y: number, x: number) => offsetAt(lines, rowAt(y), x)

  if (event.type === 'down') {
    if (event.y >= rows) return s
    const pos = at(event.y, event.x)
    return { ...s, mode: 'visual', linewise: false, anchor: pos, cursor: pos, isDragging: true, flash: undefined }
  }
  if (event.type === 'move' && s.isDragging) {
    return scrolled({ ...s, cursor: at(event.y, event.x) }, lines)
  }
  if (event.type === 'up' && s.isDragging) {
    const pos = at(event.y, event.x)
    const done = { ...s, cursor: pos, isDragging: false }
    if (pos === s.anchor) return { ...done, mode: 'normal' }
    return startComment(done, selectionRange(s.reply, s.anchor, pos, false))
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

  if (s.mode === 'help') {
    return (
      <Box flexDirection="column">
        {HELP.slice(0, bodyRows + FOOTER_ROWS).map(line => (
          <Text wrap="truncate-end">{line || ' '}</Text>
        ))}
      </Box>
    )
  }

  const lines = wrap(s.reply, columns)
  const top = Math.max(0, Math.min(s.top, Math.max(0, lines.length - bodyRows)))
  const sel =
    s.mode === 'visual'
      ? selectionRange(s.reply, s.anchor, s.cursor, s.linewise)
      : s.mode === 'comment' && s.target && 'start' in s.target
        ? s.target
        : undefined
  const showCursor = s.mode === 'normal' || s.mode === 'visual'

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
      {hintRow(surface, s)}
    </Box>
  )
}

function statusRow(surface: ClientSurface<ReaderState>, s: ReaderState, lines: readonly Line[], top: number) {
  const { Box, Text } = surface.elements
  const label = s.mode === 'visual' ? (s.linewise ? 'V-LINE' : 'VISUAL') : s.mode.toUpperCase()
  const count = `${s.comments.length} comment${s.comments.length === 1 ? '' : 's'}${s.overall.trim() ? ' + overall' : ''}`
  const row = lineOf(lines, s.cursor) + 1
  const where = `${row}/${lines.length}${top + lastLayout.bodyRows < lines.length ? ' ↓' : ''}`

  return (
    <Box flexDirection="row" gap={1}>
      <Text bold inverse>{` ${label} `}</Text>
      <Text>{count}</Text>
      <Text dimColor>{`line ${where}`}</Text>
      {s.flash ? <Text color="green">{s.flash}</Text> : null}
    </Box>
  )
}

function hintRow(surface: ClientSurface<ReaderState>, s: ReaderState) {
  const { Text } = surface.elements

  if (s.mode === 'comment') {
    const what = s.target && 'overall' in s.target ? 'Overall' : s.target && 'edit' in s.target ? 'Edit' : 'Comment'
    return <Text wrap="truncate-start">{`${what}> ${printable(s.draft)}█`}</Text>
  }
  if (s.mode === 'visual') {
    return <Text dimColor wrap="truncate-end">move to extend · c/Enter comment · o other end · v cancel</Text>
  }
  const here = commentAt(s.comments, s.cursor)
  if (here >= 0) {
    return <Text color="yellow" wrap="truncate-end">{`💬 ${printable(s.comments[here]!.text)}  (e edit · x delete)`}</Text>
  }
  return (
    <Text dimColor wrap="truncate-end">
      drag or v to select · p paragraph · o overall · s send · f to prompt · q close · ? keys
    </Text>
  )
}
