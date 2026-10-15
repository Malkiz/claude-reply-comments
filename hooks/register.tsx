import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplyComment, ReplyCommentsDraft, ReplyCommentsRelayed, ReplyCommentsView, ReplyCommentsWindow } from '../types'
import { GROUP_COLUMN, buildPrompt, conversation, lastClaudePart, legendLines, mergeComments, offsetMapper, remapComments, sliceConversation, windowAround } from './lib'
import type { TextWindow } from './lib'
import type { ReaderPost, ReaderProps } from './reader'

const PANE = 'reply-comments'
const COMMAND = 'annotate'
const PANE_OPTIONS = { id: PANE, title: 'Annotate conversation', holdToasts: true, closeOnEscape: true, rows: 30, columns: 160 } as const

// The pane can only take the keyboard once the command that opened it has
// finished, so it asks again shortly after.
const FOCUS_DELAY_MS = 300
// After Escape the keyboard has gone back to the prompt; the pane takes it back.
const REFOCUS_DELAY_MS = 80
// An Escape whose close arrives while the pane holds the keyboard, or this soon
// after it lost it (the redraw and the close race), came from inside the pane.
const ESCAPE_WINDOW_MS = 500

// A Client's props may serialize to at most 100,000 characters, so the reader
// is handed the conversation a window at a time: about this much text, made
// smaller until the props fit under the limit with room for the relayed keys.
const WINDOW_CHARS = 60_000
const PROPS_LIMIT = 95_000

const EMPTY: ReplyCommentsDraft = { reply: '', parts: [], marks: [], comments: [], overall: '', rev: 0 }
const NORMAL: ReplyCommentsView = { mode: 'normal', via: 'reader', target: 'comment', draft: '', pending: '' }

// The key field is redrawn with one of these after every keystroke, so it
// never holds what was typed. Each draw takes the next mark, so a change can be
// told apart from one typed before the field was cleared.
const MARKS = ['\u200b', '\u200c', '\u200d', '\u2060']

const draft = atom({ plugin: 'reply-comments', key: 'draft' } as const, EMPTY)
const relay = atom({ plugin: 'reply-comments', key: 'relay' } as const, [] as ReplyCommentsRelayed[])
const view = atom({ plugin: 'reply-comments', key: 'view' } as const, NORMAL)
const legend = atom({ plugin: 'reply-comments', key: 'legend' } as const, false)
const mouse = atom({ plugin: 'reply-comments', key: 'mouse' } as const, false)
const keysDrawn = atom({ plugin: 'reply-comments', key: 'keysDrawn' } as const, MARKS[0]!)
const fieldMark = atom({ plugin: 'reply-comments', key: 'fieldMark' } as const, MARKS[0]!)
const fieldRows = atom({ plugin: 'reply-comments', key: 'fieldRows' } as const, 1)
const win = atom({ plugin: 'reply-comments', key: 'window' } as const, { start: 0, end: 0 } as ReplyCommentsWindow)

/** The field's key: one per mark, so each input gets a field of its own. */
export const fieldKey = (mark: string) => 'field' + MARKS.indexOf(mark)

const unmarked = (text: string) => text.replace(/[\u200b\u200c\u200d\u2060]/g, '')


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

const ACTIONS = new Set(['send', 'fill', 'close', 'clear', 'legend', 'window'])

function asPost(data: unknown): ReaderPost | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.comments) || !d.comments.every(isComment) || typeof d.overall !== 'string' || !isView(d.view)) {
    return undefined
  }
  const action = typeof d.action === 'string' && ACTIONS.has(d.action) ? (d.action as ReaderPost['action']) : undefined
  const post: ReaderPost = { comments: d.comments, overall: d.overall, view: d.view, action }
  if (typeof d.at === 'number' && Number.isFinite(d.at)) post.at = d.at
  if (d.edge === 'start' || d.edge === 'end') post.edge = d.edge
  if (typeof d.cursor === 'number' && Number.isFinite(d.cursor)) post.cursor = d.cursor
  return post
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What the reader is handed: the window's piece of the conversation, offsets local to it. */
function readerProps(d: ReplyCommentsDraft, w: ReplyCommentsWindow, relayed: ReplyCommentsRelayed[]): ReaderProps {
  const piece = sliceConversation({ text: d.reply, parts: d.parts, marks: d.marks }, d.comments, w)
  const props: ReaderProps = {
    reply: piece.text,
    parts: piece.parts,
    marks: piece.marks,
    comments: piece.comments,
    overall: d.overall,
    rev: d.rev,
    relay: relayed,
    before: w.start > 0,
    after: w.end < d.reply.length,
    elsewhere: d.comments.length - piece.comments.length,
  }
  if (w.cursor !== undefined && w.cursor >= w.start && w.cursor <= w.end) props.cursor = w.cursor - w.start
  return props
}

/** The largest window around `center` whose props fit under the limit. */
function fitWindow(d: ReplyCommentsDraft, center: number): TextWindow {
  let size = WINDOW_CHARS
  for (;;) {
    const w = windowAround(d.reply, center, size)
    if (size < 2_000 || JSON.stringify(readerProps(d, w, [])).length <= PROPS_LIMIT) return w
    size = Math.floor(size * 0.75)
  }
}

// While the pane is open, new rows of the conversation are drawn as they are
// stored: a short wait folds a burst of rows into one refresh.
const REFRESH_DELAY_MS = 150
let isRefreshPending = false
// The reader's cursor, as an offset into the whole conversation, as last posted.
let lastCursor = 0

/**
 * Brings the open pane up to date with the conversation. Growth at the end is
 * taken in place: the comments' offsets stay valid, and the reader keeps its
 * cursor and selection. A change further up (a tool result landing above a
 * parallel call's row, a compaction) moves the comments and the cursor across
 * and re-seeds the reader.
 */
async function refresh($: EngineInterface) {
  isRefreshPending = false
  const panes = await $.ui.panes()
  if (!panes.some(p => p.id === PANE)) return
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return
  const convo = conversation(messages)
  const d = await read($, draft)
  if (convo.text === d.reply || d.reply === '') return
  if (!convo.text.startsWith(d.reply)) {
    const cursor = offsetMapper(d.reply, convo.text)(lastCursor) ?? Math.min(lastCursor, convo.text.length)
    const changed: ReplyCommentsDraft = {
      ...d,
      reply: convo.text,
      parts: convo.parts,
      marks: convo.marks,
      comments: remapComments(d.comments, d.reply, convo.text),
    }
    lastCursor = cursor
    await update($, win, () => ({ ...fitWindow(changed, cursor), cursor }))
    await update($, draft, () => ({ ...changed, rev: changed.rev + 1 }))
    return
  }

  const grown: ReplyCommentsDraft = { ...d, reply: convo.text, parts: convo.parts, marks: convo.marks }
  const w = await read($, win)
  if (w.end < d.reply.length) {
    await update($, draft, () => grown)
    return
  }
  // The window reached the end: it takes in the new text, or, past the props
  // limit, moves on with the reader re-seeded where its cursor was.
  const wider = { start: w.start, end: convo.text.length }
  if (JSON.stringify(readerProps(grown, wider, [])).length <= PROPS_LIMIT) {
    await update($, win, () => wider)
    await update($, draft, () => grown)
    return
  }
  // the window first, then the rev: the reader re-seeds on the rev, from the new window
  await update($, win, () => ({ ...fitWindow(grown, lastCursor), cursor: lastCursor }))
  await update($, draft, () => ({ ...grown, rev: grown.rev + 1 }))
}

function scheduleRefresh($: EngineInterface) {
  if (isRefreshPending) return
  isRefreshPending = true
  $.clock.after(REFRESH_DELAY_MS, () => void refresh($).catch(() => undefined))
}

/** Moves the reader's window to center on `cursor` (an offset into the whole conversation). */
async function moveWindow($: EngineInterface, cursor: number) {
  const d = await read($, draft)
  const at = Math.max(0, Math.min(cursor, d.reply.length))
  const w = fitWindow(d, at)
  await update($, win, () => ({ ...w, cursor: at }))
  await update($, draft, cur => ({ ...cur, rev: cur.rev + 1 }))
}

/**
 * The buttons a mouse user gets, for the reader's state: every basic action
 * without a key to learn. Each sends what its key would.
 */
/** Buttons after which the pane is gone or the prompt box is the point. */
const LEAVES_PANE = new Set(['send', 'fill', 'close'])

function mouseButtons(v: ReplyCommentsView): { key: string; label: string; keys: () => RelayKey[] }[] {
  if (v.mode === 'input') {
    // read at the press: the field's text changes without a redraw
    const save = (): RelayKey[] => (isTypingInPane(v) ? [{ key: 'submit', text: fieldText }] : [{ key: 'button', text: 'save' }])
    return [
      { key: 'save', label: v.inputKind === 'comment' || v.inputKind === undefined ? 'Save' : 'OK', keys: save },
      { key: 'cancel', label: 'Cancel', keys: () => [{ key: 'button', text: 'cancel' }] },
    ]
  }
  const onComment = v.mode === 'normal' && v.onComment
  return [
    ...(onComment
      ? [
          { key: 'revise', label: 'Revise', keys: () => [{ key: 'r' }] },
          { key: 'delete', label: 'Delete', keys: () => [{ key: 'x' }] },
        ]
      : []),
    { key: 'overall', label: 'Overall comment', keys: () => [{ key: 'escape' }, { key: 'o' }] },
    { key: 'send', label: 'Send', keys: () => [{ key: 'button', text: 'send' }] },
    { key: 'fill', label: 'To prompt', keys: () => [{ key: 'button', text: 'fill' }] },
    { key: 'close', label: 'Close', keys: () => [{ key: 'button', text: 'close' }] },
  ]
}

const isTypingInPane = (v: ReplyCommentsView) => v.mode === 'input' && v.via === 'pane'

/** Which field the pane draws for a view in input mode. */
const fieldKindOf = (v: ReplyCommentsView) => (v.inputKind === 'comment' || v.inputKind === undefined ? v.target : v.inputKind)

function refocus($: EngineInterface, delay: number) {
  $.clock.after(delay, () => {
    void $.ui.open({ ...PANE_OPTIONS, focus: true }).catch(() => undefined)
  })
}

async function clearDraft($: EngineInterface) {
  await update($, draft, d => ({ ...d, comments: [], overall: '', rev: d.rev + 1 }))
  await update($, view, () => NORMAL)
}

async function closePane($: EngineInterface) {
  await update($, view, () => NORMAL)
  await $.ui.close({ id: PANE })
}

async function send($: EngineInterface) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to send yet')
    return
  }
  const text = buildPrompt(d.comments, d.overall, { text: d.reply, parts: d.parts, marks: d.marks })
  await closePane($)
  await clearDraft($)
  void $.prompt.submit({ text, asUser: true }).catch(() => {
    $.ui.toast('reply-comments: the prompt could not be sent')
  })
}

async function fill($: EngineInterface) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to put in the prompt yet')
    return
  }
  const filled = await $.prompt.fill({ text: buildPrompt(d.comments, d.overall, { text: d.reply, parts: d.parts, marks: d.marks }) })
  if (!filled.isFilled) {
    $.ui.toast('reply-comments: the prompt box did not take the text; your comments are kept')
    return
  }
  await closePane($)
  await clearDraft($)
}

async function toggleLegend($: EngineInterface) {
  await update($, legend, shown => !shown)
}

/**
 * Ctrl keys never reach the key field, so each one the reader scrolls with is
 * a hidden Button pressed by an engine keybinding action. The person binds
 * the key to that action in the PaneField context of their keybindings file (see the README)
 * (the README has the block). These Select actions have no engine handler
 * mounted while the pane has the focus, so the binding presses the Button.
 * Ctrl+D is reserved by Claude Code and can never be bound.
 */
export const CTRL_ACTIONS = {
  e: 'select:next',
  y: 'select:previous',
  f: 'select:pageDown',
  u: 'select:pageUp',
} as const

/** One key handed to the reader: a key typed in the pane, a field's text, or a ctrl key. */
type RelayKey = { key: string; text?: string; ctrl?: true }

/** Hands keys to the reader, which applies each relayed key once. */
async function relayKeys($: EngineInterface, keys: RelayKey[]) {
  if (keys.length === 0) return
  await update($, relay, list => {
    let seq = list.reduce((n, r) => Math.max(n, r.seq), 0)
    const added = keys.map(k => ({ seq: ++seq, key: k.key, ...(k.text === undefined ? {} : { text: k.text }), ...(k.ctrl ? { ctrl: true as const } : {}) }))
    return [...list, ...added].slice(-40)
  })
}

/** The key field changed: hand on what was typed since it was last cleared, then clear it. */
async function onKeysTyped($: EngineInterface, value: string) {
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

// The field grows as its text wraps, the reader giving way, up to half the
// pane's body (never less than this many rows).
const MIN_FIELD_CAP = 6

// What the field's own frame takes from the row besides its label and
// submit hint (measured live: an 84-column pane wrapped its text at 64-69).
const FIELD_CHROME = 4

/** How many rows `text` takes when wrapped at whole words into `width` columns. */
function wrappedRows(text: string, width: number): number {
  let rows = 1
  let used = 0
  for (const word of text.split(' ')) {
    let w = word.length
    const need = used === 0 ? w : used + 1 + w
    if (need <= width) {
      used = need
      continue
    }
    rows++
    while (w > width) {
      w -= width
      rows++
    }
    used = w
  }
  return rows
}

/**
 * The rows a field needs for `text`: wrapped as the field wraps it, beside
 * its label and submit hint, one column narrower than measured so it grows
 * a little before the text reaches the edge.
 */
const rowsFor = (label: string, submit: string, text: string, columns: number) =>
  Math.max(1, Math.min(Math.max(MIN_FIELD_CAP, Math.floor(bodyRows / 2)), wrappedRows(text, Math.max(10, columns - label.length - submit.length - 2 - FIELD_CHROME - 1))))

/** The hint a field draws beside its text. */
const submitOf = (v: ReplyCommentsView) => (v.inputKind === 'comment' ? 'save' : 'go')

// The pane body's size, as last drawn, for sizing the field as it is typed in.
let bodyColumns = 80
// What the pane's field holds now, for the Save button.
let fieldText = ''
let bodyRows = 20

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
      description: 'Comment on parts of the conversation, then send the comments to Claude as one prompt',
      // runs at once mid-turn: the pane opens while Claude works and fills in live
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const messages = await $.session.messages()
    const convo = conversation(Array.isArray(messages) ? messages : [])
    if (!lastClaudePart(convo.parts)) return { text: 'There is no reply to annotate yet.' }

    // Unsent comments carry over while the conversation has only grown since:
    // what they point at is still where it was.
    const before = await read($, draft)
    const isKept = before.reply !== '' && convo.text.startsWith(before.reply)
    const isResumed = isKept && (before.comments.length > 0 || before.overall.trim() !== '')
    await update($, draft, d => ({
      reply: convo.text,
      parts: convo.parts,
      marks: convo.marks,
      comments: isKept ? d.comments : [],
      overall: isKept ? d.overall : '',
      rev: d.rev + 1,
    }))
    const opened = await read($, draft)
    await update($, win, () => fitWindow(opened, opened.reply.length))
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

  // A row stored in the main conversation (a prompt, a reply block, a tool
  // call or its result) reaches the open pane shortly after.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && (e.message.type === 'user' || e.message.type === 'assistant')) scheduleRefresh($)
    return stored
  })

  // The wheel (or trackpad) over the pane scrolls the reply. The pane's own
  // window never moves: the reader fills it exactly and scrolls its text itself.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    if (e.by !== 0) await relayKeys($, [{ key: 'wheel', text: String(e.by) }])
    return {}
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const post = asPost(e.data)
    if (!post) return {}

    const d = await read($, draft)
    const w = await read($, win)
    if (post.cursor !== undefined) lastCursor = w.start + post.cursor
    const comments = mergeComments(d.comments, post.comments, w)
    if (!same(d.comments, comments) || d.overall !== post.overall) {
      await update($, draft, cur => ({ ...cur, comments, overall: post.overall }))
    }
    if (post.view.mouse && !(await read($, mouse))) await update($, mouse, () => true)
    const was = await read($, view)
    if (!same(was, post.view)) {
      await update($, view, () => post.view)
      if (isTypingInPane(post.view) && !isTypingInPane(was)) {
        // A new mark draws a new field: nothing an earlier, cancelled input
        // left in it, and its cursor at the end of the text it starts with.
        const mark = MARKS[(MARKS.indexOf(await read($, fieldMark)) + 1) % MARKS.length]!
        await update($, fieldMark, () => mark)
        fieldText = post.view.draft
        await update($, fieldRows, () => rowsFor(FIELD_LABEL[fieldKindOf(post.view)], submitOf(post.view), post.view.draft, bodyColumns))
        void $.ui.focus({ requestId: PANE, key: fieldKey(mark) }).catch(() => undefined)
      } else if (!isTypingInPane(post.view) && isTypingInPane(was)) {
        void $.ui.focus({ requestId: PANE, key: 'keys' }).catch(() => undefined)
      }
    }

    if (post.action === 'send') await send($)
    if (post.action === 'fill') await fill($)
    if (post.action === 'clear') await clearDraft($)
    if (post.action === 'close') await closePane($)
    if (post.action === 'legend') await toggleLegend($)
    if (post.action === 'window') {
      const lastLine = d.reply.lastIndexOf('\n') + 1
      await moveWindow($, post.edge === 'start' ? 0 : post.edge === 'end' ? lastLine : w.start + (post.at ?? 0))
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (wasFocused && !e.props.isFocused) blurredAt = Date.now()
    wasFocused = e.props.isFocused
    const d = await read($, draft)

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const els = $.ui.resolve(e)
      const { Box, Text, Input, Button } = els
      const v = await read($, view)
      const keys = await read($, relay)
      const w = await read($, win)
      const showLegend = await read($, legend)
      const drawn = await read($, keysDrawn)
      const mark = await read($, fieldMark)
      const legendRows = showLegend ? legendLines(e.props.bodyColumns) : []
      bodyColumns = e.props.bodyColumns
      bodyRows = e.props.scroll.bodyRows
      const fieldKind = fieldKindOf(v)
      const fieldHeight = isTypingInPane(v) ? await read($, fieldRows) : 1
      const isMouse = await read($, mouse)
      const buttonRows = isMouse ? 1 : 0
      const readerRows = Math.max(3, e.props.scroll.bodyRows - legendRows.length - fieldHeight - buttonRows)

      return (
        <Box flexDirection="column">
          <els.Client
            key="reader"
            module="./reader.tsx"
            props={readerProps(d, w, keys)}
            width="100%"
            height={readerRows}
          />
          <Box flexDirection="row" height={0} overflow="hidden">
            {!isTypingInPane(v) && Object.entries(CTRL_ACTIONS).map(([key, action]) => (
              <Button key={'ctrl-' + key} label={'^' + key.toUpperCase()} plain action={action} onPress={() => relayKeys($, [{ key, ctrl: true }])} />
            ))}
          </Box>
          {isMouse ? (
            <Box flexDirection="row" height={1} overflow="hidden" columnGap={1}>
              {mouseButtons(v).map(b => (
                <Button
                  key={'mouse-' + b.key}
                  label={b.label}
                  onPress={async () => {
                    await relayKeys($, b.keys())
                    // A pressed button hands the keyboard to the prompt box; take it
                    // back, so typing goes to the pane (a new field takes it there).
                    if (!LEAVES_PANE.has(b.key)) void $.ui.open({ ...PANE_OPTIONS, focus: true }).catch(() => undefined)
                  }}
                />
              ))}
              {v.mode === 'normal' && !v.onComment ? <Text dimColor wrap="truncate-end">drag over text to comment · click a comment to change it</Text> : null}
            </Box>
          ) : null}
          {legendRows.map(row => (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text bold>{row.group.padEnd(GROUP_COLUMN)}</Text>
              <Text dimColor wrap="truncate-end">
                {row.text}
              </Text>
            </Box>
          ))}
          <Box height={fieldHeight} overflow="hidden">
            {isTypingInPane(v) ? (
              // One level deeper than the key field, so the surface draws it as a
              // field of its own: a reused one keeps the key field's cursor position.
              <Box flexGrow={1}>
                <Input
                  key={fieldKey(mark)}
                  label={FIELD_LABEL[fieldKind]}
                  value={v.draft}
                  submitLabel={submitOf(v)}
                  autoFocus
                  onInput={text => {
                    fieldText = unmarked(text)
                    const rows = rowsFor(FIELD_LABEL[fieldKind], submitOf(v), unmarked(text), bodyColumns)
                    void read($, fieldRows).then(was => (was === rows ? undefined : update($, fieldRows, () => rows)))
                  }}
                  onSubmit={text => relayKeys($, [{ key: 'submit', text: unmarked(text) }])}
                />
              </Box>
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
    const w = await read($, win)
    return (
      <Box flexDirection="column">
        <Text dimColor>Selecting spans needs the terminal or the desktop app.</Text>
        <Markdown text={d.reply.slice(w.start, w.end)} />
      </Box>
    )
  })
}
