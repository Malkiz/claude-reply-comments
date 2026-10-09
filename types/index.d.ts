export type ReplyComment = {
  /** Offset of the first selected character in the reply text. */
  start: number
  /** Offset just past the last selected character. */
  end: number
  /** The selected text, trimmed. */
  quote: string
  /** What the person wrote about it. */
  text: string
}

export type ReplyCommentsDraft = {
  /** The reply being annotated. */
  reply: string
  comments: ReplyComment[]
  overall: string
  /** Bumped whenever the hooks module replaces the draft, so the reader resets. */
  rev: number
}

/** One key typed in the pane's key field, handed on to the reader. */
export type ReplyCommentsRelayed = {
  seq: number
  key: string
  /** The text of a field, for the `submit` key. */
  text?: string
}

/** What the reader reports about itself, so the pane draws around it. */
export type ReplyCommentsView = {
  mode: 'normal' | 'visual' | 'vline' | 'input'
  /** In input mode: a comment, a `/` search or a `:` command. */
  inputKind?: 'comment' | 'search' | 'command'
  /** Where the input is typed: the pane's field, or the reader itself. */
  via: 'pane' | 'reader'
  /** What a comment is about. */
  target: 'comment' | 'edit' | 'overall'
  /** The text the field starts with. */
  draft: string
  /** Keys typed toward a command not yet complete (`g`, `ci`, `3`). */
  pending: string
}

declare module 'claude-code' {
  interface PluginState {
    'reply-comments': {
      draft: ReplyCommentsDraft
      relay: ReplyCommentsRelayed[]
      view: ReplyCommentsView
      /** Whether the key legend is shown. */
      legend: boolean
      /** What the key field holds as drawn: '' or a zero-width space, alternating so each draw clears it. */
      keysDrawn: string
      /** The zero-width mark the field (comment, search, command) starts with, new for each input. */
      fieldMark: string
    }
  }
}
