import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplyComment, ReplyCommentsDraft, ReplyCommentsRelayed, ReplyCommentsView } from '../types'
import { GROUP_COLUMN, PANE_KEYS, buildPrompt, lastReply, legendRows } from './lib'
import type { ReaderPost } from './reader'

const PANE = 'reply-comments'
const COMMAND = 'annotate'

// The pane can only take the keyboard once the command that opened it has
// finished, so it asks again shortly after.
const FOCUS_DELAY_MS = 300

const EMPTY: ReplyCommentsDraft = { reply: '', comments: [], overall: '', rev: 0 }
const NORMAL: ReplyCommentsView = { mode: 'normal', via: 'reader', target: 'comment', draft: '' }

const draft = atom({ plugin: 'reply-comments', key: 'draft' } as const, EMPTY)
const relay = atom({ plugin: 'reply-comments', key: 'relay' } as const, [] as ReplyCommentsRelayed[])
const view = atom({ plugin: 'reply-comments', key: 'view' } as const, NORMAL)

type $ = EngineInterface

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
    (w.mode === 'normal' || w.mode === 'visual' || w.mode === 'comment') &&
    (w.via === 'pane' || w.via === 'reader') &&
    (w.target === 'comment' || w.target === 'edit' || w.target === 'overall') &&
    typeof w.draft === 'string'
  )
}

function asPost(data: unknown): ReaderPost | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (
    !Array.isArray(d.comments) ||
    !d.comments.every(isComment) ||
    typeof d.overall !== 'string' ||
    !isView(d.view)
  ) {
    return undefined
  }
  const action =
    d.action === 'send' || d.action === 'fill' || d.action === 'close' || d.action === 'clear' ? d.action : undefined
  return { comments: d.comments, overall: d.overall, view: d.view, action }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

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

/** Hands a key to the reader, which applies each relayed key once. */
async function relayKey($: $, key: string, text?: string) {
  await update($, relay, list => {
    const seq = list.reduce((n, r) => Math.max(n, r.seq), 0) + 1
    const entry: ReplyCommentsRelayed = text === undefined ? { seq, key } : { seq, key, text }
    return [...list, entry].slice(-20)
  })
}

async function pressLegend($: $, key: string) {
  if (!PANE_KEYS.has(key)) return relayKey($, key)
  if (key === 's') return send($)
  if (key === 'f') return fill($)
  if (key === 'z') return clearDraft($)
  return closePane($)
}

const TARGET_LABEL: Record<ReplyCommentsView['target'], string> = {
  comment: 'Comment',
  edit: 'Revise',
  overall: 'Overall',
}

// Below this many rows for the reader, the legend switches to short labels.
const MIN_READER_ROWS = 8

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

    const pane = { id: PANE, title: 'Annotate reply', holdToasts: true as const, rows: 30 }
    await $.ui.open(pane)
    $.clock.after(FOCUS_DELAY_MS, () => {
      void $.ui.open({ ...pane, focus: true }).catch(() => undefined)
    })

    return {
      text: isResumed
        ? `Picked up your ${before.comments.length} unsent comment(s). The keys are listed at the bottom of the pane.`
        : 'The keys are listed at the bottom of the pane; you can also drag over the text with the mouse.',
    }
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
      const opensField = post.view.mode === 'comment' && post.view.via === 'pane'
      if (opensField && !(was.mode === 'comment' && was.via === 'pane')) {
        void $.ui.focus({ requestId: PANE, key: 'comment' }).catch(() => undefined)
      }
    }

    if (post.action === 'send') await send($)
    if (post.action === 'fill') await fill($)
    if (post.action === 'clear') await clearDraft($)
    if (post.action === 'close') await closePane($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await read($, draft)

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
      const v = await read($, view)
      const keys = await read($, relay)
      const isTyping = v.mode === 'comment' && v.via === 'pane'
      const full = legendRows(e.props.bodyColumns)
      const isCompact = e.props.scroll.bodyRows - full.length < MIN_READER_ROWS
      const legend = isCompact ? legendRows(e.props.bodyColumns, true) : full
      const bottomRows = isTyping ? 2 : legend.length
      const readerRows = Math.max(4, e.props.scroll.bodyRows - bottomRows)

      const bottom = isTyping ? (
        <Box flexDirection="column">
          <Input
            key="comment"
            label={TARGET_LABEL[v.target]}
            value={v.draft}
            placeholder={v.target === 'comment' ? 'what about this part?' : ''}
            submitLabel="save"
            autoFocus
            onSubmit={text => relayKey($, 'save', text)}
          />
          <Text dimColor wrap="truncate-end">
            Enter saves · an empty comment cancels (or removes the one you revise)
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {legend.map(row => (
            <Box flexDirection="row" gap={2}>
              {row.map(item =>
                'group' in item ? (
                  <Text bold>{isCompact ? item.group : item.group.padEnd(GROUP_COLUMN - 2)}</Text>
                ) : (
                  <Button
                    key={`key-${item.key.key}`}
                    hotkey={item.key.key}
                    plain
                    onPress={() => pressLegend($, item.key.key)}
                  >
                    {isCompact ? item.key.short : item.key.label}
                  </Button>
                ),
              )}
            </Box>
          ))}
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Client
            key="reader"
            module="./reader.tsx"
            props={{ reply: d.reply, comments: d.comments, overall: d.overall, rev: d.rev, relay: keys }}
            width="100%"
            height={readerRows}
          />
          {bottom}
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
