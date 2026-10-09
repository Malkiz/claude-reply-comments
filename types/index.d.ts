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

/** One key pressed on the pane's legend, handed on to the reader. */
export type ReplyCommentsRelayed = {
  seq: number
  key: string
  /** The comment text, for the `save` key the comment field sends. */
  text?: string
}

/** What the reader reports about itself, so the pane draws around it. */
export type ReplyCommentsView = {
  mode: 'normal' | 'visual' | 'comment'
  /** Where a comment is being typed: the pane's field, or the reader itself. */
  via: 'pane' | 'reader'
  /** What the comment is about. */
  target: 'comment' | 'edit' | 'overall'
  /** The text the comment field starts with. */
  draft: string
}

declare module 'claude-code' {
  interface PluginState {
    'reply-comments': {
      draft: ReplyCommentsDraft
      relay: ReplyCommentsRelayed[]
      view: ReplyCommentsView
    }
  }
}
