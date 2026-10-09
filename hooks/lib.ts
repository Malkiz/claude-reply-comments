import type { ReplyComment } from '../types'

/** One display row of the reply: the text offsets [start, end) it shows. */
export type Line = { start: number; end: number }

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

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)

/** The start of the next word after `offset`, as vim's `w`. */
export function nextWord(text: string, offset: number): number {
  let i = offset
  while (i < text.length && !isSpace(text[i])) i++
  while (i < text.length && isSpace(text[i])) i++
  return Math.min(i, Math.max(0, text.length - 1))
}

/** The start of the word before `offset`, as vim's `b`. */
export function prevWord(text: string, offset: number): number {
  let i = offset - 1
  while (i > 0 && isSpace(text[i])) i--
  while (i > 0 && !isSpace(text[i - 1])) i--
  return Math.max(0, i)
}

/** The start of the next (`dir` 1) or previous (-1) paragraph, as vim's `}` and `{`. */
export function paragraphJump(text: string, offset: number, dir: 1 | -1): number {
  if (dir === 1) {
    const gap = text.indexOf('\n\n', offset)
    if (gap < 0) return Math.max(0, text.length - 1)
    let i = gap
    while (i < text.length && text[i] === '\n') i++
    return Math.min(i, Math.max(0, text.length - 1))
  }
  const here = paragraphAt(text, offset).start
  if (here < offset) return here
  return paragraphAt(text, Math.max(0, here - 3)).start
}

/** The paragraph (text between blank lines) holding `offset`, trimmed. */
export function paragraphAt(text: string, offset: number): { start: number; end: number } {
  const before = text.lastIndexOf('\n\n', Math.max(0, offset - 1))
  const after = text.indexOf('\n\n', offset)
  return trimRange(text, before < 0 ? 0 : before + 2, after < 0 ? text.length : after)
}

/** The range with its surrounding whitespace removed. */
export function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, start)
  let e = Math.min(text.length, end)
  while (s < e && isSpace(text[s])) s++
  while (e > s && isSpace(text[e - 1])) e--
  return { start: s, end: e }
}

/**
 * What a selection between `anchor` and `cursor` covers, both ends included;
 * `linewise` widens it to whole source lines, as vim's `V`.
 */
export function selectionRange(
  text: string,
  anchor: number,
  cursor: number,
  linewise: boolean,
): { start: number; end: number } {
  let start = Math.min(anchor, cursor)
  let end = Math.min(text.length, Math.max(anchor, cursor) + 1)
  if (linewise) {
    start = text.lastIndexOf('\n', start - 1) + 1
    const nl = text.indexOf('\n', Math.max(start, end - 1))
    end = nl < 0 ? text.length : nl
  }
  return trimRange(text, start, end)
}

/** The index of the comment covering `offset`, or -1. */
export function commentAt(comments: readonly ReplyComment[], offset: number): number {
  return comments.findIndex(c => offset >= c.start && offset < c.end)
}

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

/** One key of the legend: what to press, what it does, and a shorter word for tight panes. */
export type LegendKey = { key: string; label: string; short: string }

/**
 * Every key the pane takes, grouped as the legend draws them. Hotkeys are one
 * lowercase letter or digit, so the keymap stays within those.
 */
export const LEGEND: readonly { group: string; keys: readonly LegendKey[] }[] = [
  {
    group: 'Move',
    keys: [
      { key: 'j', label: 'down', short: '↓' },
      { key: 'k', label: 'up', short: '↑' },
      { key: 'h', label: 'left', short: '←' },
      { key: 'l', label: 'right', short: '→' },
      { key: 'w', label: 'next word', short: 'word→' },
      { key: 'b', label: 'prev word', short: '←word' },
      { key: 'n', label: 'next ¶', short: '¶↓' },
      { key: 'p', label: 'prev ¶', short: '¶↑' },
      { key: 'd', label: 'page down', short: 'pg↓' },
      { key: 'u', label: 'page up', short: 'pg↑' },
      { key: 'g', label: 'top', short: 'top' },
      { key: 'e', label: 'end', short: 'end' },
    ],
  },
  {
    group: 'Select',
    keys: [
      { key: 'v', label: 'start/stop', short: 'select' },
      { key: 'a', label: 'paragraph', short: '¶' },
    ],
  },
  {
    group: 'Comment',
    keys: [
      { key: 'c', label: 'comment', short: 'comment' },
      { key: 'o', label: 'overall', short: 'overall' },
      { key: 'r', label: 'revise', short: 'revise' },
      { key: 'x', label: 'delete', short: 'delete' },
      { key: 'm', label: 'next comment', short: 'next' },
    ],
  },
  {
    group: 'Finish',
    keys: [
      { key: 's', label: 'send', short: 'send' },
      { key: 'f', label: 'to prompt', short: 'to prompt' },
      { key: 'z', label: 'clear all', short: 'clear' },
      { key: 'q', label: 'close', short: 'close' },
    ],
  },
]

/** The keys the pane handles itself rather than handing to the reader. */
export const PANE_KEYS = new Set(['s', 'f', 'z', 'q'])

/** The width of the group-name column in the full legend, its gap included. */
export const GROUP_COLUMN = 9

/** One row of the legend: group names and keys, in drawing order. */
export type LegendRow = ({ group: string } | { key: LegendKey })[]

const cellsOf = (item: LegendRow[number], compact: boolean) =>
  'group' in item
    ? compact
      ? item.group.length + 2
      : GROUP_COLUMN
    : item.key.key.length + 2 + (compact ? item.key.short : item.key.label).length + 2

/**
 * Lays the legend out in rows of at most `width` cells. Full: one group per
 * row (wrapping under its name), full labels. Compact: short labels, the
 * groups flowing on from one another, for a pane with little room.
 */
export function legendRows(width: number, compact = false): LegendRow[] {
  const w = Math.max(20, width)
  const rows: LegendRow[] = []
  let row: LegendRow = []
  let used = 0
  const put = (item: LegendRow[number]) => {
    const cells = cellsOf(item, compact)
    if (row.length > 0 && used + cells > w) {
      rows.push(row)
      row = compact ? [] : [{ group: '' }]
      used = compact ? 0 : GROUP_COLUMN
    }
    row.push(item)
    used += cells
  }
  for (const { group, keys } of LEGEND) {
    if (!compact && row.length > 0) {
      rows.push(row)
      row = []
      used = 0
    }
    put({ group })
    for (const key of keys) put({ key })
  }
  if (row.length > 0) rows.push(row)
  return rows
}
