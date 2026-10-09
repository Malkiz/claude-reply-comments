import type { ReplyComment } from '../types'

/** One display row of the reply: the text offsets [start, end) it shows. */
export type Line = { start: number; end: number }

/** A span of the reply: offsets [start, end). */
export type Range = { start: number; end: number }

/** A message as `$.session.messages()` answers it, the fields read here. */
type MessageLike = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly unknown[]
  toolResults?: readonly unknown[]
}

/**
 * The text of Claude's last reply: the newest assistant text, joined with the
 * assistant texts before it in the same turn (tool calls and their results in
 * between), stopping at the person's prompt.
 */
export function lastReply(messages: readonly MessageLike[]): string {
  let i = messages.length - 1
  while (i >= 0 && !(messages[i]!.role === 'assistant' && messages[i]!.text.trim())) i--
  if (i < 0) return ''

  const parts: string[] = []
  for (; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      if (m.text.trim()) parts.unshift(m.text.trim())
      continue
    }
    const isToolResultOnly = (m.toolResults?.length ?? 0) > 0 && !m.text.trim()
    if (!isToolResultOnly && m.text.trim()) break
  }

  return parts.join('\n\n')
}

// ---------- display rows ----------

/** Breaks the text into display rows of at most `width` cells, at spaces where it can. */
export function wrap(text: string, width: number): Line[] {
  const w = Math.max(1, Math.floor(width))
  const lines: Line[] = []
  let base = 0

  for (const para of text.split('\n')) {
    if (para.length === 0) lines.push({ start: base, end: base })
    let i = 0
    while (i < para.length) {
      let end = Math.min(i + w, para.length)
      if (end < para.length) {
        const space = para.lastIndexOf(' ', end - 1)
        if (space > i) end = space + 1
      }
      lines.push({ start: base + i, end: base + end })
      i = end
    }
    base += para.length + 1
  }

  return lines
}

/** The index of the display row holding `offset`. */
export function lineOf(lines: readonly Line[], offset: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid]!.start <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The last offset the cursor may rest on in a row (its start when empty). */
export function lastOf(line: Line): number {
  return Math.max(line.start, line.end - 1)
}

/** The offset at `column` of row `index`, clamped to the row. */
export function offsetAt(lines: readonly Line[], index: number, column: number): number {
  const line = lines[Math.max(0, Math.min(lines.length - 1, index))]!
  return Math.min(line.start + Math.max(0, column), lastOf(line))
}

// ---------- source lines ----------

/** The offset where the source line holding `i` starts. */
export function lineStart(text: string, i: number): number {
  return text.lastIndexOf('\n', i - 1) + 1
}

/** The offset of the newline ending the source line holding `i` (or the text's end). */
export function lineEnd(text: string, i: number): number {
  const nl = text.indexOf('\n', i)
  return nl < 0 ? text.length : nl
}

/** The last offset the cursor may rest on in the source line holding `i`. */
export function lineLast(text: string, i: number): number {
  const s = lineStart(text, i)
  return Math.max(s, lineEnd(text, i) - 1)
}

/** The first non-blank offset of the source line holding `i`, as vim's `^`. */
export function firstNonBlank(text: string, i: number): number {
  const s = lineStart(text, i)
  const e = lineEnd(text, i)
  let j = s
  while (j < e && (text[j] === ' ' || text[j] === '\t')) j++
  return j < e ? j : s
}

/** The start offset of source line `n` (1-based), clamped to the text. */
export function nthLine(text: string, n: number): number {
  let at = 0
  for (let k = 1; k < n; k++) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) break
    at = nl + 1
  }
  return Math.min(at, Math.max(0, text.length - 1))
}

/** The 1-based number of the source line holding `i`. */
export function lineNumber(text: string, i: number): number {
  let n = 1
  for (let k = 0; k < i && k < text.length; k++) if (text[k] === '\n') n++
  return n
}

// ---------- words ----------

/** vim's character classes: 0 blank, 1 word (letters, digits, _), 2 other; a WORD is any non-blank. */
function cls(c: string | undefined, big: boolean): number {
  if (c === undefined || /\s/.test(c)) return 0
  if (big) return 1
  return /[\p{L}\p{N}_]/u.test(c) ? 1 : 2
}

/** An empty line: a newline that follows a newline (or opens the text). */
const isEmptyLineAt = (t: string, j: number) => t[j] === '\n' && (j === 0 || t[j - 1] === '\n')

const lastIndex = (t: string) => Math.max(0, t.length - 1)

/** vim's `w` / `W`: the start of the next word (an empty line counts as one). */
export function wordForward(t: string, i: number, big: boolean): number {
  let j = i
  const c = cls(t[j], big)
  if (c !== 0) while (j < t.length && cls(t[j], big) === c) j++
  while (j < t.length && cls(t[j], big) === 0) {
    if (j > i && isEmptyLineAt(t, j)) return j
    j++
  }
  return Math.min(j, lastIndex(t))
}

/** vim's `b` / `B`: the start of this word, or of the one before. */
export function wordBackward(t: string, i: number, big: boolean): number {
  let j = i - 1
  while (j > 0 && cls(t[j], big) === 0) {
    if (isEmptyLineAt(t, j)) return j
    j--
  }
  if (j <= 0) return 0
  const c = cls(t[j], big)
  while (j > 0 && cls(t[j - 1], big) === c) j--
  return j
}

/** vim's `e` / `E`: the end of this word, or of the next. */
export function wordEnd(t: string, i: number, big: boolean): number {
  let j = i + 1
  while (j < t.length && cls(t[j], big) === 0) j++
  if (j >= t.length) return lastIndex(t)
  const c = cls(t[j], big)
  while (j + 1 < t.length && cls(t[j + 1], big) === c) j++
  return j
}

/** vim's `ge` / `gE`: the end of the word before. */
export function wordEndBackward(t: string, i: number, big: boolean): number {
  let j = i
  const c = cls(t[j], big)
  if (c !== 0) while (j > 0 && cls(t[j - 1], big) === c) j--
  j--
  while (j > 0 && cls(t[j], big) === 0) j--
  return Math.max(0, j)
}

// ---------- paragraphs ----------

/** vim's `}` / `{`: the next / previous empty line, or the text's end / start. */
export function paragraphMove(t: string, i: number, dir: 1 | -1): number {
  let j = i
  if (dir === 1) {
    while (j < t.length && isEmptyLineAt(t, j)) j++
    while (j < t.length && !isEmptyLineAt(t, j)) j++
    return Math.min(j, lastIndex(t))
  }
  while (j > 0 && isEmptyLineAt(t, j)) j--
  while (j > 0 && !isEmptyLineAt(t, j)) j--
  return j
}

/** The paragraph (text between empty lines) holding `offset`, trimmed. */
export function paragraphAt(text: string, offset: number): Range {
  const before = text.lastIndexOf('\n\n', Math.max(0, offset - 1))
  const after = text.indexOf('\n\n', offset)
  return trimRange(text, before < 0 ? 0 : before + 2, after < 0 ? text.length : after)
}

// ---------- finding ----------

export type FindCommand = 'f' | 'F' | 't' | 'T'

/**
 * vim's `f` `F` `t` `T` within the source line; undefined when the character
 * is not there. `t` and `T` stay put when it is right next to the cursor,
 * unless `isRepeat` (a `;` or `,`), which looks past it.
 */
export function findChar(t: string, i: number, cmd: FindCommand, ch: string, isRepeat = false): number | undefined {
  const skip = isRepeat && (cmd === 't' || cmd === 'T') ? 1 : 0
  if (cmd === 'f' || cmd === 't') {
    const at = t.indexOf(ch, i + 1 + skip)
    if (at < 0 || at >= lineEnd(t, i)) return undefined
    return cmd === 't' ? at - 1 : at
  }
  const from = i - 1 - skip
  if (from < 0) return undefined
  const at = t.lastIndexOf(ch, from)
  if (at < 0 || at < lineStart(t, i)) return undefined
  return cmd === 'T' ? at + 1 : at
}

/** Every match of `pattern` in the text, smartcase (ignores case unless the pattern has a capital). */
export function searchMatches(t: string, pattern: string): number[] {
  if (!pattern) return []
  const ignoreCase = pattern === pattern.toLowerCase()
  const hay = ignoreCase ? t.toLowerCase() : t
  const needle = ignoreCase ? pattern.toLowerCase() : pattern
  const found: number[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) found.push(at)
  return found
}

/** The next (`dir` 1) or previous match after `i`, wrapping around; undefined when none. */
export function searchFrom(t: string, i: number, pattern: string, dir: 1 | -1): number | undefined {
  const found = searchMatches(t, pattern)
  if (found.length === 0) return undefined
  if (dir === 1) return found.find(at => at > i) ?? found[0]
  return [...found].reverse().find(at => at < i) ?? found[found.length - 1]
}

// ---------- text objects ----------

const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
  '[': ['[', ']'], ']': ['[', ']'],
  '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
  '<': ['<', '>'], '>': ['<', '>'],
}
const QUOTES = new Set(['"', "'", '`'])

/** The characters that may follow `i` or `a` to name a text object. */
export const TEXT_OBJECTS = new Set(['w', 'W', 'p', 's', ...Object.keys(PAIRS), ...QUOTES])

/**
 * vim's text objects around `i`: `iw` `aw` `iW` `aW`, `is` `as` (sentence),
 * `ip` `ap`, brackets `i(` `a(` (and `[ { <`, `b` `B`), quotes `i"` `a"` (and
 * `' \``). Undefined when there is none at the cursor.
 */
export function textObject(t: string, i: number, around: boolean, obj: string): Range | undefined {
  if (!t) return undefined
  if (obj === 'w' || obj === 'W') {
    const big = obj === 'W'
    const c = cls(t[i], big)
    let s = i
    let e = i + 1
    while (s > 0 && cls(t[s - 1], big) === c && t[s - 1] !== '\n') s--
    while (e < t.length && cls(t[e], big) === c && t[e] !== '\n') e++
    if (around) {
      const e0 = e
      while (e < t.length && (t[e] === ' ' || t[e] === '\t')) e++
      if (e === e0) while (s > 0 && (t[s - 1] === ' ' || t[s - 1] === '\t')) s--
    }
    return { start: s, end: e }
  }
  if (obj === 'p') {
    let s = lineStart(t, i)
    let e = lineEnd(t, i)
    const blank = s === e
    while (s > 0 && (lineStart(t, s - 1) === s - 1) === blank) s = lineStart(t, s - 1)
    while (e < t.length && (lineEnd(t, e + 1) === e + 1) === blank) e = lineEnd(t, e + 1)
    if (around && !blank) while (e < t.length && lineEnd(t, e + 1) === e + 1) e = lineEnd(t, e + 1)
    return { start: s, end: e }
  }
  if (obj === 's') {
    const para = paragraphAt(t, i)
    let s = para.start
    for (let j = i - 1; j >= para.start; j--) {
      if (/[.!?]/.test(t[j]!) && /\s/.test(t[j + 1] ?? ' ')) {
        s = j + 1
        break
      }
    }
    while (s < para.end && /\s/.test(t[s]!)) s++
    let e = para.end
    for (let j = Math.max(i, s); j < para.end; j++) {
      if (/[.!?]/.test(t[j]!) && /\s|$/.test(t[j + 1] ?? '')) {
        e = j + 1
        break
      }
    }
    if (around) while (e < para.end && /\s/.test(t[e]!)) e++
    return { start: s, end: e }
  }
  if (PAIRS[obj]) {
    const [open, close] = PAIRS[obj]!
    let depth = 0
    let s = -1
    for (let j = i; j >= 0; j--) {
      if (t[j] === close && j !== i) depth++
      else if (t[j] === open) {
        if (depth === 0) {
          s = j
          break
        }
        depth--
      }
    }
    if (s < 0) {
      // Not inside a pair: take the next one opening on this line, as vim does for quotes.
      const next = t.indexOf(open, i)
      if (next < 0 || next >= lineEnd(t, i)) return undefined
      s = next
    }
    depth = 0
    let e = -1
    for (let j = s + 1; j < t.length; j++) {
      if (t[j] === open) depth++
      else if (t[j] === close) {
        if (depth === 0) {
          e = j
          break
        }
        depth--
      }
    }
    if (e < 0) return undefined
    return around ? { start: s, end: e + 1 } : { start: s + 1, end: e }
  }
  if (QUOTES.has(obj)) {
    // Quotes pair up along the line, first with second, third with fourth.
    const marks: number[] = []
    for (let j = lineStart(t, i); j < lineEnd(t, i); j++) if (t[j] === obj) marks.push(j)
    for (let k = 0; k + 1 < marks.length; k += 2) {
      const s = marks[k]!
      const e = marks[k + 1]!
      if (i <= e) return around ? { start: s, end: e + 1 } : { start: s + 1, end: e }
    }
    return undefined
  }
  return undefined
}

// ---------- ranges ----------

/** The range with its surrounding whitespace removed. */
export function trimRange(text: string, start: number, end: number): Range {
  let s = Math.max(0, start)
  let e = Math.min(text.length, end)
  while (s < e && /\s/.test(text[s]!)) s++
  while (e > s && /\s/.test(text[e - 1]!)) e--
  return { start: s, end: e }
}

/**
 * What a selection between `anchor` and `cursor` covers, both ends included;
 * `linewise` widens it to whole source lines, as vim's `V`.
 */
export function selectionRange(text: string, anchor: number, cursor: number, linewise: boolean): Range {
  let start = Math.min(anchor, cursor)
  let end = Math.min(text.length, Math.max(anchor, cursor) + 1)
  if (linewise) {
    start = lineStart(text, start)
    end = lineEnd(text, Math.max(start, end - 1))
  }
  return trimRange(text, start, end)
}

/** The index of the comment covering `offset`, or -1. */
export function commentAt(comments: readonly ReplyComment[], offset: number): number {
  return comments.findIndex(c => offset >= c.start && offset < c.end)
}

// ---------- the prompt ----------

const MAX_QUOTE = 1500

function quote(text: string): string {
  const cut =
    text.length > MAX_QUOTE
      ? `${text.slice(0, MAX_QUOTE / 2)}\n[…]\n${text.slice(-MAX_QUOTE / 2)}`
      : text
  return cut
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

/** The one prompt that carries every comment, each under the span it is about. */
export function buildPrompt(comments: readonly ReplyComment[], overall: string): string {
  const sorted = [...comments].sort((a, b) => a.start - b.start)
  const parts: string[] = []

  if (sorted.length > 0) {
    parts.push(
      sorted.length === 1
        ? 'I left a comment on part of your last reply:'
        : `I left ${sorted.length} comments on parts of your last reply:`,
    )
    sorted.forEach((c, i) => parts.push(`${i + 1}. On this part:\n${quote(c.quote)}\n\n${c.text}`))
  }
  if (overall.trim()) {
    parts.push(sorted.length > 0 ? `Overall: ${overall.trim()}` : overall.trim())
  }

  return parts.join('\n\n')
}

// ---------- the legend ----------

/** The keys, by group, as the legend lists them. */
export const LEGEND: readonly { group: string; text: string }[] = [
  { group: 'Move', text: 'h j k l · w b e ge (W B E gE) · 0 ^ $ · gg G · { } · H M L · f t F T ; , · counts (3j) · ctrl-d ctrl-u after a click' },
  { group: 'Select', text: 'v V · o other end · text objects iw aw is ip ap i( a( i" a" … · Esc cancels' },
  { group: 'Comment', text: 'c on a selection · c{motion}: cip ciw cc c$ · o overall · r revise · x delete · ]c [c next/prev' },
  { group: 'Search', text: '/text then Enter · n N' },
  { group: 'Finish', text: 's send · :p to prompt · :clear · q close · zz zt zb scroll · ? hide keys' },
]

/** The group-name column, its gap included. */
const GROUP_COLUMN = 9

/** The legend broken into rows of at most `width` cells, each row a group name (or '') and text. */
export function legendLines(width: number): { group: string; text: string }[] {
  const room = Math.max(10, width - GROUP_COLUMN)
  const rows: { group: string; text: string }[] = []
  for (const { group, text } of LEGEND) {
    let row = ''
    let first = true
    for (const part of text.split(' · ')) {
      const next = row ? `${row} · ${part}` : part
      if (row && next.length > room) {
        rows.push({ group: first ? group : '', text: row })
        first = false
        row = part
      } else {
        row = next
      }
    }
    rows.push({ group: first ? group : '', text: row })
  }
  return rows
}

export { GROUP_COLUMN }
