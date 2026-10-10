import type { ReplyComment, ReplyCommentsView } from '../types'
import {
  TEXT_OBJECTS,
  commentAt,
  findChar,
  firstNonBlank,
  lastOf,
  lineEnd,
  lineLast,
  lineOf,
  lineStart,
  nthLine,
  offsetAt,
  paragraphMove,
  searchFrom,
  selectionRange,
  textObject,
  trimRange,
  wordBackward,
  wordEnd,
  wordEndBackward,
  wordForward,
  wrap,
} from './lib'
import type { FindCommand, Line, Range } from './lib'

/** The reader's size: text columns and the rows the text shows in. */
export type Layout = { columns: number; rows: number }

export type Mode = ReplyCommentsView['mode']
export type InputKind = NonNullable<ReplyCommentsView['inputKind']>
export type Via = ReplyCommentsView['via']

/** What a comment being written is about. */
export type Target = Range | { overall: true } | { edit: number }

export type VimState = {
  rev: number
  reply: string
  mode: Mode
  inputKind?: InputKind
  via: Via
  cursor: number
  anchor: number
  /** The display column `j` and `k` aim for; -1 takes the cursor's own. */
  want: number
  target?: Target
  draft: string
  /** Keys typed toward a command not yet complete (`g`, `ci`, `3`). */
  pending: string
  lastFind?: { cmd: FindCommand; ch: string }
  search: string
  comments: ReplyComment[]
  overall: string
  top: number
  flash?: string
  /** Comments held outside the text this state covers (a window of a longer conversation). */
  elsewhere?: number
}

/** What the pane does on the reader's behalf. */
export type Action = 'send' | 'fill' | 'close' | 'clear' | 'legend'

export type StepResult = { state: VimState; action?: Action }

/** A key as the reader's keyboard or the pane's key field hands it. */
export type KeyIn = { key: string; ctrl?: true; meta?: true }

export function initialState(reply: string, comments: ReplyComment[], overall: string, rev: number): VimState {
  return {
    rev,
    reply,
    mode: 'normal',
    via: 'reader',
    cursor: 0,
    anchor: 0,
    want: -1,
    draft: '',
    pending: '',
    search: '',
    comments,
    overall,
    top: 0,
  }
}

export function viewOf(s: VimState): ReplyCommentsView {
  const target = s.target && 'overall' in s.target ? 'overall' : s.target && 'edit' in s.target ? 'edit' : 'comment'
  const view: ReplyCommentsView = {
    mode: s.mode,
    via: s.via,
    target,
    draft: s.mode === 'input' ? s.draft : '',
    pending: s.pending,
  }
  if (s.mode === 'input' && s.inputKind) view.inputKind = s.inputKind
  return view
}

// ---------- layout ----------

const linesOf = (s: VimState, layout: Layout) => wrap(s.reply, layout.columns)

/** Keeps the cursor's row inside the window, scrolling no more than needed. */
export function scrolled(s: VimState, layout: Layout, lines: readonly Line[] = linesOf(s, layout)): VimState {
  const row = lineOf(lines, s.cursor)
  let top = s.top
  if (row < top) top = row
  if (row >= top + layout.rows) top = row - layout.rows + 1
  top = Math.max(0, Math.min(top, Math.max(0, lines.length - layout.rows)))
  return top === s.top ? s : { ...s, top }
}

/** Moves the window `rows` down (negative: up), the cursor kept on screen, as vim's `ctrl-e` / `ctrl-y`. */
export function scrollBy(s: VimState, layout: Layout, rows: number): VimState {
  const lines = linesOf(s, layout)
  const maxTop = Math.max(0, lines.length - layout.rows)
  const top = Math.max(0, Math.min(maxTop, s.top + rows))
  const row = lineOf(lines, s.cursor)
  const col = s.cursor - lines[row]!.start
  const kept = Math.max(top, Math.min(top + layout.rows - 1, row))
  return { ...s, top, cursor: kept === row ? s.cursor : offsetAt(lines, kept, col) }
}

// ---------- motions ----------

type Motion = { to: number; kind: 'exclusive' | 'inclusive' | 'linewise'; want?: number; find?: VimState['lastFind'] }

const PREFIXES = new Set(['g', ']', '[', 'f', 'F', 't', 'T', 'z'])

/** The motion `keys` names from the cursor, 'pending' while it needs more keys, or undefined. */
export function motion(s: VimState, keys: string, count: number | undefined, layout: Layout): Motion | 'pending' | undefined {
  const t = s.reply
  const n = count ?? 1
  const lines = linesOf(s, layout)
  const row = lineOf(lines, s.cursor)
  const col = s.want >= 0 ? s.want : s.cursor - lines[row]!.start
  const repeat = (f: (i: number) => number) => {
    let i = s.cursor
    for (let k = 0; k < n; k++) i = f(i)
    return i
  }

  switch (keys) {
    case 'h':
      return { to: Math.max(lineStart(t, s.cursor), s.cursor - n), kind: 'exclusive' }
    case 'l':
      return { to: Math.min(lineLast(t, s.cursor), s.cursor + n), kind: 'exclusive' }
    case 'j':
      return { to: offsetAt(lines, row + n, col), kind: 'linewise', want: col }
    case 'k':
      return { to: offsetAt(lines, row - n, col), kind: 'linewise', want: col }
    case 'w':
    case 'W':
      return { to: repeat(i => wordForward(t, i, keys === 'W')), kind: 'exclusive' }
    case 'b':
    case 'B':
      return { to: repeat(i => wordBackward(t, i, keys === 'B')), kind: 'exclusive' }
    case 'e':
    case 'E':
      return { to: repeat(i => wordEnd(t, i, keys === 'E')), kind: 'inclusive' }
    case 'ge':
    case 'gE':
      return { to: repeat(i => wordEndBackward(t, i, keys === 'gE')), kind: 'inclusive' }
    case '0':
      return { to: lineStart(t, s.cursor), kind: 'exclusive' }
    case '^':
      return { to: firstNonBlank(t, s.cursor), kind: 'exclusive' }
    case '$': {
      let i = s.cursor
      for (let k = 1; k < n; k++) i = Math.min(t.length - 1, lineEnd(t, i) + 1)
      return { to: lineLast(t, i), kind: 'inclusive', want: Number.MAX_SAFE_INTEGER }
    }
    case 'gg':
      return { to: firstNonBlank(t, count ? nthLine(t, count) : 0), kind: 'linewise' }
    case 'G':
      return { to: firstNonBlank(t, count ? nthLine(t, count) : t.length - 1), kind: 'linewise' }
    case '}':
      return { to: repeat(i => paragraphMove(t, i, 1)), kind: 'exclusive' }
    case '{':
      return { to: repeat(i => paragraphMove(t, i, -1)), kind: 'exclusive' }
    case 'H':
      return { to: offsetAt(lines, s.top + (count ? count - 1 : 0), 0), kind: 'linewise' }
    case 'M':
      return { to: offsetAt(lines, s.top + Math.floor((Math.min(layout.rows, lines.length - s.top) - 1) / 2), 0), kind: 'linewise' }
    case 'L':
      return { to: offsetAt(lines, Math.min(lines.length, s.top + layout.rows) - 1 - (count ? count - 1 : 0), 0), kind: 'linewise' }
    case ';':
    case ',': {
      if (!s.lastFind) return undefined
      const flip: Record<FindCommand, FindCommand> = { f: 'F', F: 'f', t: 'T', T: 't' }
      const cmd = keys === ';' ? s.lastFind.cmd : flip[s.lastFind.cmd]
      return findMotion(s, cmd, s.lastFind.ch, n, false)
    }
    case 'n':
    case 'N': {
      let i: number | undefined = s.cursor
      for (let k = 0; k < n && i !== undefined; k++) i = searchFrom(t, i, s.search, keys === 'n' ? 1 : -1)
      return i === undefined ? undefined : { to: i, kind: 'exclusive' }
    }
    case ']c':
    case '[c': {
      let i = s.cursor
      for (let k = 0; k < n; k++) {
        const hit =
          keys === ']c'
            ? s.comments.find(c => c.start > i)
            : [...s.comments].reverse().find(c => c.start < i)
        if (!hit) break
        i = hit.start
      }
      return i === s.cursor ? undefined : { to: i, kind: 'exclusive' }
    }
  }

  if (keys.length === 1 && PREFIXES.has(keys)) return 'pending'
  if (keys.length === 2 && 'fFtT'.includes(keys[0]!)) {
    return findMotion(s, keys[0] as FindCommand, keys[1]!, n, true)
  }
  return undefined
}

function findMotion(s: VimState, cmd: FindCommand, ch: string, n: number, remember: boolean): Motion | undefined {
  let i: number | undefined = s.cursor
  for (let k = 0; k < n && i !== undefined; k++) i = findChar(s.reply, i, cmd, ch, !remember || k > 0)
  if (i === undefined) return undefined
  const m: Motion = { to: i, kind: cmd === 'f' || cmd === 't' ? 'inclusive' : 'exclusive' }
  if (remember) m.find = { cmd, ch }
  return m
}

/** The span an operator covers from the cursor over a motion, as vim's `c{motion}`. */
function motionRange(s: VimState, m: Motion): Range {
  const t = s.reply
  let start = Math.min(s.cursor, m.to)
  let end = Math.max(s.cursor, m.to)
  if (m.kind === 'inclusive') end += 1
  if (m.kind === 'linewise') {
    start = lineStart(t, start)
    end = lineEnd(t, end)
  }
  return { start, end: Math.min(end, t.length) }
}

// ---------- comments ----------

function startComment(s: VimState, range: Range, via: Via): VimState {
  const r = trimRange(s.reply, range.start, range.end)
  if (r.end <= r.start) return { ...s, mode: 'normal', pending: '', flash: 'Nothing to comment on there' }
  return { ...s, mode: 'input', inputKind: 'comment', via, target: r, draft: '', pending: '', cursor: r.start, want: -1 }
}

function saveComment(s: VimState, text: string): VimState {
  const body = text.trim()
  const base: VimState = { ...s, mode: 'normal', inputKind: undefined, target: undefined, draft: '' }
  const target = s.target
  if (!target) return base
  if ('overall' in target) {
    return { ...base, overall: body, flash: body ? 'Overall comment saved' : 'Overall comment removed' }
  }
  if ('edit' in target) {
    const comments = body
      ? s.comments.map((c, i) => (i === target.edit ? { ...c, text: body } : c))
      : s.comments.filter((_, i) => i !== target.edit)
    return { ...base, comments, flash: body ? 'Comment updated' : 'Comment removed' }
  }
  if (!body) return { ...base, flash: 'Empty comment discarded' }
  const comment: ReplyComment = { start: target.start, end: target.end, quote: s.reply.slice(target.start, target.end), text: body }
  const comments = [...s.comments, comment].sort((a, b) => a.start - b.start)
  return { ...base, comments, flash: `Comment ${comments.length} saved` }
}

function runCommand(s: VimState, text: string, layout: Layout): StepResult {
  const cmd = text.trim()
  const base: VimState = { ...s, mode: 'normal', inputKind: undefined, draft: '' }
  const hasAny = s.comments.length > 0 || (s.elsewhere ?? 0) > 0 || s.overall.trim() !== ''
  if (/^\d+$/.test(cmd)) return { state: scrolled({ ...base, cursor: firstNonBlank(s.reply, nthLine(s.reply, Number(cmd))) }, layout) }
  switch (cmd) {
    case '':
      return { state: base }
    case 'w':
    case 'wq':
    case 'x':
    case 'send':
      return hasAny ? { state: base, action: 'send' } : { state: { ...base, flash: 'Nothing to send yet' } }
    case 'p':
    case 'prompt':
      return hasAny ? { state: base, action: 'fill' } : { state: { ...base, flash: 'Nothing to put in the prompt yet' } }
    case 'q':
    case 'q!':
    case 'close':
      return { state: base, action: 'close' }
    case 'clear':
      return { state: base, action: 'clear' }
    case 'h':
    case 'help':
      return { state: base, action: 'legend' }
    default:
      return { state: { ...base, flash: `Not a command: :${cmd}` } }
  }
}

/** The text a pane field (or the reader, in place) handed over for the input under way. */
export function submitInput(s: VimState, text: string, layout: Layout): StepResult {
  if (s.mode !== 'input') return { state: s }
  if (s.inputKind === 'comment') return { state: saveComment(s, text) }
  if (s.inputKind === 'command') return runCommand(s, text, layout)
  const pattern = text || s.search
  const base: VimState = { ...s, mode: 'normal', inputKind: undefined, draft: '', search: pattern }
  const at = pattern ? searchFrom(s.reply, s.cursor, pattern, 1) : undefined
  if (at === undefined) return { state: { ...base, flash: pattern ? `Not found: ${pattern}` : '' } }
  return { state: scrolled({ ...base, cursor: at, want: -1 }, layout) }
}

// ---------- keys ----------

/** Escape: leaves an input, a selection or a half-typed command. In plain normal mode it does nothing. */
export function escape(s: VimState): VimState {
  if (s.mode === 'input') return { ...s, mode: 'normal', inputKind: undefined, target: undefined, draft: '', pending: '', flash: 'Cancelled' }
  if (s.mode === 'visual' || s.mode === 'vline') return { ...s, mode: 'normal', pending: '' }
  return s.pending ? { ...s, pending: '' } : s
}

const NAMED: Record<string, string> = {
  left: 'h', right: 'l', up: 'k', down: 'j', backspace: 'h', space: 'l', home: '0', end: '$',
  return: '\r', enter: '\r',
}

function typeInPlace(s: VimState, ev: KeyIn, layout: Layout): StepResult {
  const { key } = ev
  if (ev.ctrl && key === 'u') return { state: { ...s, draft: '' } }
  if (key === 'return' || key === 'enter') return submitInput(s, s.draft, layout)
  if (key === 'backspace' || key === 'delete') {
    if (!s.draft) return { state: escape(s) }
    return { state: { ...s, draft: [...s.draft].slice(0, -1).join('') } }
  }
  if (key === 'space') return { state: { ...s, draft: `${s.draft} ` } }
  if (ev.ctrl || ev.meta || key.length > 1 && /^[a-z]+$/.test(key)) return { state: s }
  return { state: { ...s, draft: s.draft + key.replace(/[\r\n\t]+/g, ' ') } }
}

function ctrlKey(s: VimState, key: string, layout: Layout): StepResult {
  const half = Math.max(1, Math.floor(layout.rows / 2))
  const lines = linesOf(s, layout)
  const row = lineOf(lines, s.cursor)
  const col = s.cursor - lines[row]!.start
  const jump = (rows: number) => {
    const moved = scrollBy(s, layout, rows)
    return { state: scrolled({ ...moved, cursor: offsetAt(lines, row + rows, col) }, layout, lines) }
  }
  switch (key) {
    case 'd':
      return jump(half)
    case 'u':
      return jump(-half)
    case 'f':
      return jump(layout.rows)
    case 'b':
      return jump(-layout.rows)
    case 'e':
      return { state: scrollBy(s, layout, 1) }
    case 'y':
      return { state: scrollBy(s, layout, -1) }
    case 'c':
      return { state: escape(s) }
    default:
      return { state: s }
  }
}

/**
 * One key. `via` says where it came from: the reader's own keyboard (after a
 * click) or the pane's key field. Pure: the state after it, and anything the
 * pane must do.
 */
export function step(prev: VimState, ev: KeyIn, via: Via, layout: Layout): StepResult {
  const s: VimState = prev.flash !== undefined ? { ...prev, flash: undefined } : prev
  if (ev.key === 'escape' || (ev.ctrl && (ev.key === 'c' || ev.key === '['))) return { state: escape(s) }
  if (s.mode === 'input') return via === 'reader' ? typeInPlace(s, ev, layout) : { state: s }
  if (!s.reply) return { state: s }
  if (ev.ctrl) return ctrlKey(s, ev.key, layout)

  const key = NAMED[ev.key] ?? ev.key
  if (key.length !== 1) return { state: s }
  const seq = s.pending + key
  const parsed = /^([1-9]\d*)?([\s\S]*)$/.exec(seq)!
  const count = parsed[1] ? Number(parsed[1]) : undefined
  const rest = parsed[2]!
  if (rest === '') return { state: { ...s, pending: seq } }

  const isVisual = s.mode === 'visual' || s.mode === 'vline'
  const wait = { state: { ...s, pending: seq } }
  const drop = (flash?: string) => ({ state: flash ? { ...s, pending: '', flash } : { ...s, pending: '' } })

  // c{motion}, cc, c{text object}: comment on that span
  if (!isVisual && rest[0] === 'c') {
    const after = rest.slice(1)
    if (after === '') return wait
    if (after === 'c') {
      const ls = lineStart(s.reply, s.cursor)
      let le = lineEnd(s.reply, s.cursor)
      for (let k = 1; k < (count ?? 1); k++) le = lineEnd(s.reply, Math.min(s.reply.length, le + 1))
      return { state: startComment(s, { start: ls, end: le }, via) }
    }
    if (after[0] === 'i' || after[0] === 'a') {
      if (after.length === 1) return wait
      const r = TEXT_OBJECTS.has(after[1]!) ? textObject(s.reply, s.cursor, after[0] === 'a', after[1]!) : undefined
      return r ? { state: startComment(s, r, via) } : drop('No such text object here')
    }
    const inner = /^([1-9]\d*)?([\s\S]*)$/.exec(after)!
    const n = (count ?? 1) * (inner[1] ? Number(inner[1]) : 1)
    if (inner[2] === '') return wait
    const keys = inner[2] === 'w' ? 'e' : inner[2] === 'W' ? 'E' : inner[2]!
    const m = motion(s, keys, n === 1 && !count && !inner[1] ? undefined : n, layout)
    if (m === 'pending') return wait
    if (!m) return drop()
    return { state: startComment(s, motionRange(s, m), via) }
  }

  // visual text objects: iw, ap, i( …
  if (isVisual && (rest[0] === 'i' || rest[0] === 'a')) {
    if (rest.length === 1) return wait
    const r = TEXT_OBJECTS.has(rest[1]!) ? textObject(s.reply, s.cursor, rest[0] === 'a', rest[1]!) : undefined
    if (!r || r.end <= r.start) return drop('No such text object here')
    return { state: scrolled({ ...s, mode: 'visual', pending: '', anchor: r.start, cursor: r.end - 1, want: -1 }, layout) }
  }

  // zz zt zb
  if (rest[0] === 'z' && rest.length === 2) {
    const lines = linesOf(s, layout)
    const row = lineOf(lines, s.cursor)
    const maxTop = Math.max(0, lines.length - layout.rows)
    const top = rest[1] === 'z' ? row - Math.floor(layout.rows / 2) : rest[1] === 't' ? row : rest[1] === 'b' ? row - layout.rows + 1 : s.top
    return { state: { ...s, pending: '', top: Math.max(0, Math.min(maxTop, top)) } }
  }

  const m = motion(s, rest, count, layout)
  if (m === 'pending') return wait
  if (m) {
    const moved: VimState = { ...s, pending: '', cursor: m.to, want: m.want ?? -1 }
    if (m.find) moved.lastFind = m.find
    return { state: scrolled(moved, layout) }
  }

  if (rest.length > 1) return drop()
  return command(s, rest, via, layout)
}

function command(s0: VimState, key: string, via: Via, layout: Layout): StepResult {
  const s: VimState = { ...s0, pending: '' }
  const isVisual = s.mode === 'visual' || s.mode === 'vline'
  const here = commentAt(s.comments, s.cursor)
  const hasAny = s.comments.length > 0 || (s.elsewhere ?? 0) > 0 || s.overall.trim() !== ''

  if (key === '?') return { state: s, action: 'legend' }

  if (isVisual) {
    switch (key) {
      case 'c':
      case '\r':
        return { state: startComment(s, selectionRange(s.reply, s.anchor, s.cursor, s.mode === 'vline'), via) }
      case 'o':
      case 'O':
        return { state: scrolled({ ...s, anchor: s.cursor, cursor: s.anchor }, layout) }
      case 'v':
        return { state: { ...s, mode: s.mode === 'visual' ? 'normal' : 'visual' } }
      case 'V':
        return { state: { ...s, mode: s.mode === 'vline' ? 'normal' : 'vline' } }
      default:
        return { state: s }
    }
  }

  switch (key) {
    case 'v':
      return { state: { ...s, mode: 'visual', anchor: s.cursor } }
    case 'V':
      return { state: { ...s, mode: 'vline', anchor: s.cursor } }
    case '\r': {
      const m = motion(s, 'j', undefined, layout)
      if (!m || m === 'pending') return { state: s }
      return { state: scrolled({ ...s, cursor: firstNonBlank(s.reply, m.to), want: -1 }, layout) }
    }
    case 'o':
      return { state: { ...s, mode: 'input', inputKind: 'comment', via, target: { overall: true }, draft: s.overall } }
    case 'r':
      if (here < 0) return { state: { ...s, flash: 'No comment under the cursor' } }
      return { state: { ...s, mode: 'input', inputKind: 'comment', via, target: { edit: here }, draft: s.comments[here]!.text } }
    case 'x':
      if (here < 0) return { state: { ...s, flash: 'No comment under the cursor' } }
      return { state: { ...s, comments: s.comments.filter((_, i) => i !== here), flash: 'Comment removed' } }
    case '/':
      return { state: { ...s, mode: 'input', inputKind: 'search', via, draft: '' } }
    case ':':
      return { state: { ...s, mode: 'input', inputKind: 'command', via, draft: '' } }
    case 's':
      return hasAny ? { state: s, action: 'send' } : { state: { ...s, flash: 'Nothing to send yet' } }
    case 'q':
      return { state: s, action: 'close' }
    default:
      return { state: s }
  }
}

/** The span the reader shows selected now, if any. */
export function selection(s: VimState): Range | undefined {
  if (s.mode === 'visual' || s.mode === 'vline') return selectionRange(s.reply, s.anchor, s.cursor, s.mode === 'vline')
  if (s.mode === 'input' && s.target && 'start' in s.target) return s.target
  return undefined
}

export { lastOf }
