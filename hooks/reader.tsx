import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { ReplyComment, ReplyCommentsMark, ReplyCommentsPart, ReplyCommentsRelayed, ReplyCommentsView } from '../types'
import { commentAt, lastClaudePart, lineOf, offsetAt, searchMatches, selectionRange, wrap } from './lib'
import type { Line } from './lib'
import { caretOf, escape, initialState, scrollBy, scrolled, selection, step, submitInput, viewOf } from './vim'
import type { Action, Layout, StepResult, VimState } from './vim'

/** What the hooks module hands the reader. */
export type ReaderProps = {
  /** The conversation as one text. */
  reply: string
  parts: ReplyCommentsPart[]
  marks: ReplyCommentsMark[]
  comments: ReplyComment[]
  overall: string
  rev: number
  /** Keys typed in the pane's key field, newest last; applied once each, by `seq`. */
  relay: ReplyCommentsRelayed[]
  /** Whether the conversation goes on above / below this window of it. */
  before?: boolean
  after?: boolean
  /** Comments outside this window, counted in the status row. */
  elsewhere?: number
  /** Where the cursor goes when the window has moved, local to it. */
  cursor?: number
}

/** What the reader posts back: the whole draft and its own view, each time. */
export type ReaderPost = {
  comments: ReplyComment[]
  overall: string
  view: ReplyCommentsView
  action?: Action | 'window'
  /** With `window`: the cursor, local, to center the next window on. */
  at?: number
  /** With `window`: go to the conversation's very start or end (`gg`, `G`). */
  edge?: 'start' | 'end'
  /** The cursor, local to the window, so a window moved for new text keeps it. */
  cursor?: number
}

type ReaderState = VimState & { relaySeq: number; isDragging: boolean }

/** The status row under the text. */
const FOOTER_ROWS = 1
/** The `❯` / `⏺` column left of the text, as the transcript draws it. */
const GUTTER = 2
/** How near the window's edge (a share of its text) the cursor comes before the window moves. */
const EDGE_SHARE = 0.15

// The instance's live state: handlers read it so keys pressed faster than a
// frame build on each other instead of on the last drawn state.
let live: ReaderState | undefined
let liveSurface: unknown
let layout: Layout = { columns: 80, rows: 10 }

const newestSeq = (relay: readonly ReplyCommentsRelayed[] | undefined) =>
  (relay ?? []).reduce((n, r) => Math.max(n, r.seq), 0)

/**
 * Where a new annotation opens: the cursor on Claude's last reply or plan, the window
 * at the bottom of the conversation as the transcript sits, or at the reply's
 * start when the reply is taller than the window.
 */
function opening(props: ReaderProps, at: Layout): { cursor: number; top: number } {
  const lines = wrap(props.reply, at.columns)
  if (props.cursor !== undefined) {
    // the window moved: the cursor stays where it was, mid-screen
    const cursor = Math.max(0, Math.min(props.cursor, Math.max(0, props.reply.length - 1)))
    const row = lineOf(lines, cursor)
    return { cursor, top: Math.max(0, Math.min(row - Math.floor(at.rows / 2), lines.length - at.rows)) }
  }
  const cursor = Math.max(0, lastClaudePart(props.parts ?? [])?.start ?? 0)
  const row = lineOf(lines, cursor)
  return { cursor, top: Math.max(0, Math.min(row - 1, lines.length - at.rows)) }
}

/**
 * The conversation grew while the pane was open: the new text is appended and
 * the cursor, selection and comments stay. A view that was showing the end
 * follows it down, as the transcript does, while the cursor stays on screen.
 */
function grow(s: ReaderState, reply: string, at: Layout, starts: number[]): ReaderState {
  const before = wrap(s.reply, at.columns)
  const after = wrap(reply, at.columns)
  const wasAtEnd = s.top + at.rows >= before.length
  const grown = { ...s, reply, starts }
  if (!wasAtEnd) return grown
  const top = Math.max(0, after.length - at.rows)
  return lineOf(after, s.cursor) >= top ? { ...grown, top } : grown
}

/** Where each message in the window starts (one cut by the window's start has none). */
const startsOf = (props: ReaderProps) => (props.parts ?? []).filter(p => p.start >= 0).map(p => p.start)

/**
 * Whether the reader should ask for another window: `gg` / `G` with more of
 * the conversation beyond, or the cursor near an edge the conversation goes on
 * past. Only in normal mode, so a selection or an input is never cut short.
 */
function windowAsk(prev: ReaderState, next: ReaderState, key: string, props: ReaderProps): Pick<ReaderPost, 'at' | 'edge'> | undefined {
  if (next.mode !== 'normal' || next.pending !== '') return undefined
  if (key === 'g' && prev.pending === 'g' && props.before) return { edge: 'start' }
  if (key === 'G' && prev.pending === '' && props.after) return { edge: 'end' }
  const edge = next.reply.length * EDGE_SHARE
  if (next.cursor === prev.cursor) {
    // ]m / [m with no further message in this window: bring in the next piece
    if (key === 'm' && prev.pending.endsWith(']') && props.after) return { at: next.reply.length - 1 }
    if (key === 'm' && prev.pending.endsWith('[') && props.before) return { at: 0 }
    return undefined
  }
  if ((props.before && next.cursor < edge) || (props.after && next.cursor > next.reply.length - edge)) return { at: next.cursor }
  return undefined
}

// The rev a window was asked for under, so it is asked for once.
let askedRev = -1

function fresh(props: ReaderProps, prev: ReaderState | undefined, isSameInstance: boolean, at: Layout): ReaderState {
  const base = initialState(props.reply, props.comments, props.overall, props.rev)
  const keep = prev !== undefined && prev.reply === props.reply
  const open = keep ? undefined : opening(props, at)
  return {
    ...base,
    cursor: open ? open.cursor : Math.min(prev!.cursor, Math.max(0, props.reply.length - 1)),
    top: open ? open.top : prev!.top,
    search: keep ? prev.search : '',
    elsewhere: props.elsewhere ?? 0,
    starts: startsOf(props),
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
  const columns = Math.max(10, (surface.columns > 0 ? surface.columns : 80) - GUTTER)
  const rows = Math.max(1, (surface.rows > 0 ? surface.rows : 12) - FOOTER_ROWS)
  layout = { columns, rows }

  if (!isSameInstance || live === undefined || live.rev !== props.rev) {
    live = fresh(props, isSameInstance ? live : surface.state, isSameInstance, layout)
    liveSurface = surface
  } else if (props.reply !== live.reply) {
    // grown at the end: appended in place; changed any other way: re-seeded, so
    // the text drawn and the parts and marks it is drawn with never disagree
    live = props.reply.startsWith(live.reply)
      ? grow(live, props.reply, layout, startsOf(props))
      : fresh(props, undefined, true, layout)
  }

  const commit = (next: ReaderState, action?: Action, ask?: Pick<ReaderPost, 'at' | 'edge'>) => {
    live = next
    surface.setState(next)
    const data: ReaderPost = { comments: next.comments, overall: next.overall, view: viewOf(next), cursor: next.cursor }
    if (action) data.action = action
    else if (ask && askedRev !== next.rev) {
      askedRev = next.rev
      Object.assign(data, { action: 'window' }, ask)
    }
    surface.post(data)
  }

  // Keys typed in the pane's key field arrive as props: apply each new one once.
  const pending = (props.relay ?? []).filter(r => r.seq > live!.relaySeq)
  if (pending.length > 0) {
    let s = live
    let action: Action | undefined
    let ask: Pick<ReaderPost, 'at' | 'edge'> | undefined
    for (const r of pending) {
      const before = s
      const result =
        r.key === 'submit'
          ? apply(s, submitInput(s, r.text ?? '', layout))
          : r.key === 'escape'
            ? { state: { ...s, ...escape(s) } }
            : r.key === 'wheel'
              ? { state: { ...s, ...scrollBy(s, layout, Number(r.text) || 0) } }
            : apply(s, step(s, r.ctrl ? { key: r.key, ctrl: true } : { key: r.key }, 'pane', layout))
      s = { ...result.state, relaySeq: r.seq }
      action = result.action ?? action
      ask = windowAsk(before, s, r.key, props) ?? ask
    }
    commit(s, action, ask)
  }

  surface.onKey(event => {
    if (!live) return
    const result = apply(live, step(live, event, 'reader', layout))
    commit(result.state, result.action, windowAsk(live, result.state, event.key, props))
  })
  surface.onPointer(event => {
    if (!live) return
    const next = onPointer(live, event)
    if (next !== live) commit(next)
  })

  return draw(surface, live, props, columns, rows)
}

export default Reader

// ---------- mouse ----------

export function onPointer(s: ReaderState, event: ClientPointerEvent): ReaderState {
  if (!s.reply) return s
  if (event.button !== undefined && event.button !== 'left') return s
  // A press while a comment (or a search or command) is open drops it, as Esc
  // does: a click just leaves it, a drag selects a new span to comment on.
  // a click on a draft typed in place puts the caret there
  if (s.mode === 'input' && s.via === 'reader' && event.type === 'down' && event.y === layout.rows) {
    const shown = draftView(s, layout.columns + GUTTER)
    const col = event.x - shown.textStart
    return col < 0 ? s : { ...s, caret: Math.min([...s.draft].length, shown.start + col) }
  }
  if (s.mode === 'input') {
    if (event.type !== 'down' || event.y >= layout.rows) return s
    s = { ...s, ...escape(s) }
  }

  const lines = wrap(s.reply, layout.columns)
  const rowAt = (y: number) => s.top + Math.max(-1, Math.min(layout.rows, y))
  const at = (y: number, x: number) => offsetAt(lines, rowAt(y), Math.max(0, x - GUTTER))

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
    return { ...done, mode: 'input', inputKind: 'comment', via: 'reader', target: r, draft: '', caret: undefined, cursor: r.start }
  }
  return s
}

// ---------- drawing ----------

type Style = 'plain' | 'cursor' | 'selected' | 'commented' | 'match' | ReplyCommentsMark['style']

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
    case 'bold':
    case 'heading':
      return { bold: true }
    case 'code':
      return { color: 'blue' }
    case 'dim':
      return { dimColor: true }
    default:
      return {}
  }
}

const printable = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ')

function draw(surface: ClientSurface<ReaderState>, s: ReaderState, props: ReaderProps, columns: number, rows: number) {
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
  const marks = (props.marks ?? []).filter(m => m.end > from && m.start < to)
  const parts = props.parts ?? []

  const styleAt = (offset: number): Style => {
    if (showCursor && offset === s.cursor) return 'cursor'
    if (sel && offset >= sel.start && offset < sel.end) return 'selected'
    if (commentAt(s.comments, offset) >= 0) return 'commented'
    if (matches.some(at => offset >= at && offset < at + matchLen)) return 'match'
    let mark: Style = 'plain'
    for (const m of marks) if (offset >= m.start && offset < m.end) mark = m.style
    return mark
  }

  // The transcript's gutter: `❯` on a prompt, `⏺` on a reply block or a tool call.
  const gutter = (line: Line) => {
    const part = parts.find(p => p.start === line.start)
    if (!part) return <Text>{'  '}</Text>
    if (part.role === 'user') return <Text dimColor>{'❯ '}</Text>
    if (part.role === 'tool') return <Text color={part.isError ? 'red' : 'green'}>{'⏺ '}</Text>
    if (part.role === 'plan') return <Text color="cyan">{'⏺ '}</Text>
    return <Text>{'⏺ '}</Text>
  }

  // Every row is exactly one cell tall, so nothing below it ever moves.
  const textRows = visible.map(line => {
    if (line.end === line.start) {
      return (
        <Box flexDirection="row" height={1} overflow="hidden">
          {gutter(line)}
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
        {gutter(line)}
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
      {statusRow(surface, s, lines, top, rows, props.elsewhere ?? 0)}
    </Box>
  )
}

const MODE_LABEL: Record<VimState['mode'], string> = {
  normal: 'NORMAL',
  visual: 'VISUAL',
  vline: 'V-LINE',
  input: 'INPUT',
}

const labelOf = (s: ReaderState) =>
  s.mode !== 'input' ? MODE_LABEL[s.mode] : s.inputKind === 'comment' ? 'COMMENT' : s.inputKind === 'search' ? 'SEARCH' : 'COMMAND'
const prefixOf = (s: ReaderState) => (s.inputKind === 'search' ? '/' : s.inputKind === 'command' ? ':' : '> ')

/**
 * The draft typed in place as the status row shows it in `width` columns:
 * the window of it kept around the caret, with '…' when its start is cut,
 * and the column its first shown character sits at.
 */
export function draftView(s: ReaderState, width: number) {
  const chars = [...printable(s.draft)]
  const caret = caretOf(s)
  // the label (' COMMENT '), a gap, then the prefix
  const head = labelOf(s).length + 3 + prefixOf(s).length
  const room = Math.max(4, width - head)
  let start = 0
  if (chars.length + 1 > room) start = Math.max(0, Math.min(caret - room + 2, chars.length + 2 - room))
  const lead = start > 0 ? '…' : ''
  const visible = chars.slice(start, start + room - lead.length)
  const at = caret - start
  return {
    start,
    textStart: head + lead.length,
    lead,
    before: visible.slice(0, at).join(''),
    at: visible[at] ?? ' ',
    after: visible.slice(at + 1).join(''),
  }
}

function statusRow(surface: ClientSurface<ReaderState>, s: ReaderState, lines: readonly Line[], top: number, rows: number, elsewhere: number) {
  const { Box, Text } = surface.elements
  const label = labelOf(s)
  const total = s.comments.length + elsewhere
  const count = `${total} comment${total === 1 ? '' : 's'}${s.overall.trim() ? ' + overall' : ''}`
  const where = `${lineOf(lines, s.cursor) + 1}/${lines.length}${top + rows < lines.length ? ' ↓' : ''}`

  let info = ''
  let color: string | undefined
  if (s.mode === 'input') {
    info = s.via === 'pane' ? 'type below · Enter finishes · Esc cancels' : ''
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
      {s.mode === 'input' && s.via === 'reader' ? (
        (() => {
          const d = draftView(s, surface.columns > 0 ? surface.columns : 80)
          return (
            <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
              <Text>{prefixOf(s) + d.lead + d.before}</Text>
              <Text inverse>{d.at}</Text>
              <Text wrap="truncate-end">{d.after}</Text>
            </Box>
          )
        })()
      ) : (
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={color} dimColor={!color && s.mode === 'input' && s.via === 'pane'} wrap="truncate-end">
            {info || ' '}
          </Text>
        </Box>
      )}
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
}
