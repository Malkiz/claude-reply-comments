import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplyComment, ReplyCommentsDraft, ReplyCommentsRelayed, ReplyCommentsView } from '../types'
import { GROUP_COLUMN, buildPrompt, lastReply, legendLines } from './lib'
import type { ReaderPost } from './reader'

const PANE = 'reply-comments'
const COMMAND = 'annotate'
const PANE_OPTIONS = { id: PANE, title: 'Annotate reply', holdToasts: true, closeOnEscape: true, rows: 30 } as const

// The pane can only take the keyboard once the command that opened it has
// finished, so it asks again shortly after.
const FOCUS_DELAY_MS = 300
// After Escape the keyboard has gone back to the prompt; the pane takes it back.
const REFOCUS_DELAY_MS = 80
// An Escape whose close arrives while the pane holds the keyboard, or this soon
// after it lost it (the redraw and the close race), came from inside the pane.
const ESCAPE_WINDOW_MS = 500

const EMPTY: ReplyCommentsDraft = { reply: '', comments: [], overall: '', rev: 0 }
const NORMAL: ReplyCommentsView = { mode: 'normal', via: 'reader', target: 'comment', draft: '', pending: '' }

// The key field is redrawn with one of these after every keystroke, so it
// never holds what was typed. Each draw takes the next mark, so a change can be
// told apart from one typed before the field was cleared.
const MARKS = ['​', '‌', '‍', '⁠']

const draft = atom({ plugin: 'reply-comments', key: 'draft' } as const, EMPTY)
const relay = atom({ plugin: 'reply-comments', key: 'relay' } as const, [] as ReplyCommentsRelayed[])
const view = atom({ plugin: 'reply-comments', key: 'view' } as const, NORMAL)
const legend = atom({ plugin: 'reply-comments', key: 'legend' } as const, false)
const keysDrawn = atom({ plugin: 'reply-comments', key: 'keysDrawn' } as const, MARKS[0]!)
const fieldMark = atom({ plugin: 'reply-comments', key: 'fieldMark' } as const, MARKS[0]!)

const unmarked = (text: string) => text.replace(/[\u200b\u200c\u200d\u2060]/g, '')

type $ = EngineInterface

// How much of each mark's field text has been handed on already.
const consumed = new Map<string, number>()
let wasFocused = false
let blurredAt = 0

function isComment(v: unknown): v is ReplyComment {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.start === 'number' &&
    typeof c.end === 'number' &&
    typeof c.quote === 'string' &&
    typeof c.text === 'string'
  )
}

function isView(v: unknown): v is ReplyCommentsView {
  if (typeof v !== 'object' || v === null) return false
  const w = v as Record<string, unknown>
  return (
    (w.mode === 'normal' || w.mode === 'visual' || w.mode === 'vline' || w.mode === 'input') &&
    (w.inputKind === undefined || w.inputKind === 'comment' || w.inputKind === 'search' || w.inputKind === 'command') &&
    (w.via === 'pane' || w.via === 'reader') &&
    (w.target === 'comment' || w.target === 'edit' || w.target === 'overall') &&
    typeof w.draft === 'string' &&
    typeof w.pending === 'string'
  )
}

const ACTIONS = new Set(['send', 'fill', 'close', 'clear', 'legend'])

function asPost(data: unknown): ReaderPost | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.comments) || !d.comments.every(isComment) || typeof d.overall !== 'string' || !isView(d.view)) {
    return undefined
  }
  const action = typeof d.action === 'string' && ACTIONS.has(d.action) ? (d.action as ReaderPost['action']) : undefined
  return { comments: d.comments, overall: d.overall, view: d.view, action }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const isTypingInPane = (v: ReplyCommentsView) => v.mode === 'input' && v.via === 'pane'

function refocus($: $, delay: number) {
  $.clock.after(delay, () => {
    void $.ui.open({ ...PANE_OPTIONS, focus: true }).catch(() => undefined)
  })
}

async function clearDraft($: $) {
  await update($, draft, d => ({ ...d, comments: [], overall: '', rev: d.rev + 1 }))
  await update($, view, () => NORMAL)
}

async function closePane($: $) {
  await update($, view, () => NORMAL)
  await $.ui.close({ id: PANE })
}

async function send($: $) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to send yet')
    return
  }
  const text = buildPrompt(d.comments, d.overall)
  await closePane($)
  await clearDraft($)
  void $.prompt.submit({ text, asUser: true }).catch(() => {
    $.ui.toast('reply-comments: the prompt could not be sent')
  })
}

async function fill($: $) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to put in the prompt yet')
    return
  }
  const filled = await $.prompt.fill({ text: buildPrompt(d.comments, d.overall) })
  if (!filled.isFilled) {
    $.ui.toast('reply-comments: the prompt box did not take the text; your comments are kept')
    return
  }
  await closePane($)
  await clearDraft($)
}

async function toggleLegend($: $) {
  await update($, legend, shown => !shown)
}

/** Hands keys to the reader, which applies each relayed key once. */
async function relayKeys($: $, keys: { key: string; text?: string }[]) {
  if (keys.length === 0) return
  await update($, relay, list => {
    let seq = list.reduce((n, r) => Math.max(n, r.seq), 0)
    const added = keys.map(k => (k.text === undefined ? { seq: ++seq, key: k.key } : { seq: ++seq, key: k.key, text: k.text }))
    return [...list, ...added].slice(-40)
  })
}

/** The key field changed: hand on what was typed since it was last cleared, then clear it. */
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
  await relayKeys($, typed.map(key => ({ key })))
}

const FIELD_LABEL = {
  comment: 'Comment',
  edit: 'Revise',
  overall: 'Overall',
  search: '/',
  command: ':',
} as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Comment on parts of Claude's last reply, then send the comments as one prompt",
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const messages = await $.session.messages()
    const reply = Array.isArray(messages) ? lastReply(messages) : ''
    if (!reply) return { text: 'There is no reply to annotate yet.' }

    const before = await read($, draft)
    const isResumed = before.reply === reply && (before.comments.length > 0 || before.overall.trim() !== '')
    await update($, draft, d =>
      d.reply === reply ? { ...d, rev: d.rev + 1 } : { reply, comments: [], overall: '', rev: d.rev + 1 },
    )
    await update($, view, () => NORMAL)
    await update($, legend, () => false)

    await $.ui.open(PANE_OPTIONS)
    refocus($, FOCUS_DELAY_MS)

    const keys = 'Vim keys work in the pane; ? shows them all.'
    return {
      text: isResumed ? `Picked up your ${before.comments.length} unsent comment(s). ${keys}` : keys,
    }
  })

  // Escape reaches the pane as its close (closeOnEscape). From inside the pane
  // it never closes it: it leaves a selection, an input or a half-typed command,
  // and in plain normal mode does nothing, as in vim; either way the pane takes
  // the keyboard back. `q` closes. A close from outside the pane (its mark while
  // unfocused, Escape at an idle prompt) goes through.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    const v = await read($, view)
    const isFromPane = wasFocused || Date.now() - blurredAt < ESCAPE_WINDOW_MS
    if (v.mode !== 'normal' || v.pending !== '') {
      await relayKeys($, [{ key: 'escape' }])
    } else if (!isFromPane) {
      return next(e)
    }
    refocus($, REFOCUS_DELAY_MS)
    return { deny: 'Escape stays in the pane; q closes it' }
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const post = asPost(e.data)
    if (!post) return {}

    const d = await read($, draft)
    if (!same(d.comments, post.comments) || d.overall !== post.overall) {
      await update($, draft, cur => ({ ...cur, comments: post.comments, overall: post.overall }))
    }
    const was = await read($, view)
    if (!same(was, post.view)) {
      await update($, view, () => post.view)
      if (isTypingInPane(post.view) && !isTypingInPane(was)) {
        // A new mark makes the field drop whatever an earlier, cancelled input left in it.
        await update($, fieldMark, cur => MARKS[(MARKS.indexOf(cur) + 1) % MARKS.length]!)
        void $.ui.focus({ requestId: PANE, key: 'field' }).catch(() => undefined)
      } else if (!isTypingInPane(post.view) && isTypingInPane(was)) {
        void $.ui.focus({ requestId: PANE, key: 'keys' }).catch(() => undefined)
      }
    }

    if (post.action === 'send') await send($)
    if (post.action === 'fill') await fill($)
    if (post.action === 'clear') await clearDraft($)
    if (post.action === 'close') await closePane($)
    if (post.action === 'legend') await toggleLegend($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (wasFocused && !e.props.isFocused) blurredAt = Date.now()
    wasFocused = e.props.isFocused
    const d = await read($, draft)

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Text, Input, Client } = $.ui.resolve(e)
      const v = await read($, view)
      const keys = await read($, relay)
      const showLegend = await read($, legend)
      const drawn = await read($, keysDrawn)
      const mark = await read($, fieldMark)
      const legendRows = showLegend ? legendLines(e.props.bodyColumns) : []
      const readerRows = Math.max(3, e.props.scroll.bodyRows - legendRows.length - 1)
      const fieldKind = v.inputKind === 'comment' || v.inputKind === undefined ? v.target : v.inputKind

      return (
        <Box flexDirection="column">
          <Client
            key="reader"
            module="./reader.tsx"
            props={{ reply: d.reply, comments: d.comments, overall: d.overall, rev: d.rev, relay: keys }}
            width="100%"
            height={readerRows}
          />
          {legendRows.map(row => (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text bold>{row.group.padEnd(GROUP_COLUMN)}</Text>
              <Text dimColor wrap="truncate-end">
                {row.text}
              </Text>
            </Box>
          ))}
          <Box height={1} overflow="hidden">
            {isTypingInPane(v) ? (
              <Input
                key="field"
                label={FIELD_LABEL[fieldKind]}
                value={mark + v.draft}
                submitLabel={v.inputKind === 'comment' ? 'save' : 'go'}
                autoFocus
                onSubmit={text => relayKeys($, [{ key: 'submit', text: unmarked(text) }])}
              />
            ) : (
              <Input
                key="keys"
                label={showLegend ? 'keys' : 'keys (? help)'}
                value={drawn}
                submitLabel="enter"
                autoFocus
                onInput={value => onKeysTyped($, value)}
                onSubmit={() => relayKeys($, [{ key: 'return' }])}
              />
            )}
          </Box>
        </Box>
      )
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>Selecting spans needs the terminal or the desktop app.</Text>
        <Markdown text={d.reply} />
      </Box>
    )
  })
}
