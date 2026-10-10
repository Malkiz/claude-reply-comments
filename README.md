# claude-reply-comments

A Claude Code mod for commenting inline on any part of the conversation, the way a PR review or Notion comments work. All the comments then go back to Claude as one prompt.

> [!WARNING]
> **100% vibe coded.** Claude wrote all of this, and I have not read a single line of the code. Use it at your own discretion. I am not responsible for any weird stuff that happens while you use this mod. Mods run unsandboxed inside Claude Code, so read the source before you install it. The [MIT license](LICENSE) applies: no warranty of any kind.

Requires Claude Code with mods (function hooks): 2.1.286 or later. Built for the terminal (tmux on macOS), and it also draws in the desktop Code tab.

## Use

`/annotate` opens a pane with the whole conversation and gives it the keyboard. The pane draws the conversation the way the transcript does: `❯` on your prompts, `⏺` on Claude's replies and tool calls (`Bash(ls)` with its first result line), markdown rendered. A plan Claude presents in plan mode is drawn in full, so you can comment on its steps (reject the plan dialog, then `/annotate`). It opens at the bottom with the cursor on Claude's last reply or plan, and you can move anywhere above it.

`/annotate` opens at once even while Claude is working. The pane stays live: while it is open, new prompts, replies and tool calls appear in it as Claude works (a block at a time), without moving your cursor or selection. Click the prompt box to type there while the pane stays open. The keys are vim's. `?` shows or hides the full key list at the bottom of the pane. It starts hidden every time.

| Group | Keys |
| --- | --- |
| Move | `h j k l` · `w b e ge` (`W B E gE`) · `0 ^ $` · `gg G` (`5G` goes to line 5) · `{ }` · `]m [m` next / previous message · `H M L` · `f t F T ; ,` · counts (`3j`, `2w`) · `ctrl-d ctrl-u ctrl-f ctrl-b ctrl-e ctrl-y` after clicking the reply |
| Select | `v` · `V` · `o` swaps ends · text objects `iw aw iW aW is as ip ap i( a( i[ i{ i< i" i' i\``… |
| Comment | `c` on a selection · `c{motion}` comments that span: `cip ciw ci( cc c$ c2e`… · `o` overall comment · `r` revise / `x` delete the comment under the cursor · `]c` `[c` next/prev comment |
| Search | `/text` then Enter (smartcase) · `n N` |
| Finish | `s` send · `:w` send · `:p` put the prompt in the prompt box · `:clear` · `q` / `:q` close (the draft is kept) · `:12` go to line 12 · `zz zt zb` scroll |

`c`, `o`, `r`, `/` and `:` open a field at the bottom with the keyboard in it. Enter finishes. Esc cancels. An empty comment cancels, or removes the one you're revising.

Esc never takes you out of the pane: it leaves visual mode, a field or a half-typed command, and does nothing in normal mode. `q` closes the pane.

With the mouse, the wheel scrolls the conversation, and dragging over text selects it and starts a comment. Clicking the conversation also hands it the keyboard directly, which adds the ctrl keys. In that case the comment is typed in place and `ctrl-c` cancels it.

The prompt quotes each selected span, with its comment under it, in conversation order. When every comment is on Claude's last reply it says so once; otherwise each comment names the message it is on (your message, Claude's reply to a given prompt, a tool call).

Unsent comments are kept when you close the pane, and still there when you reopen it after the conversation has grown.

A long conversation is handed to the reader a window at a time (about 60,000 characters), because a `Client`'s props may serialize to at most 100,000 characters. The window moves by itself as the cursor nears its edge, and `gg` / `G` jump to the very start and end. Within a window, line numbers in the status row, `:12` and `/` search cover that window only. Comments are kept for the whole conversation.

The pane opens docked beside the transcript. Its width is the one Claude Code keeps for every pane: drag the divider to make it as wide as you like (the transcript keeps at least 24 columns).

## Install

Clone the repo and load the folder as a plugin:

```sh
git clone https://github.com/Malkiz/claude-reply-comments.git
claude --plugin-dir ./claude-reply-comments
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the `/annotate` command, the pane, its key field, field and legend, Esc, sending and filling the prompt.
- `hooks/reader.tsx`: the `Client` surface module that draws the conversation (gutter, markdown styles, cursor, comments) and handles mouse and keys.
- `hooks/vim.ts`: the vim engine: motions, operators, modes.
- `hooks/lib.ts`: the conversation as one text (`conversation`, `renderMarkdown`), wrapping, word/paragraph/text-object primitives, prompt building and the legend.
- `types/index.d.ts`: the `$.state` contract.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod. That folder is gitignored.

### How the keyboard reaches the reader

A `Client` gets keys only after a click. So the pane draws an `Input` (the key field) that holds the keyboard. Each change is handed to the reader through `$.state` (`relay`, applied once each by `seq`), and the field is redrawn with a new zero-width mark so it never fills up. Ctrl keys don't reach an `Input`, which is why they need the click.

The pane is opened with `closeOnEscape`, so Esc arrives as a `ui.close` the mod refuses, handing the reader an `escape` and taking the keyboard back with a delayed `$.ui.open({ focus })`. The same delayed open gives the pane the keyboard after `/annotate`, because a `focus` request made inside the command is refused.

Every row in the pane is exactly one cell tall, and the reader's height is the pane's body less the legend and the field. Nothing the reader draws can push the layout around.

The vim engine is `hooks/vim.ts`: pure functions, tested in `tests/vim.test.ts`.

## Ideas

- [ ] **Show past comments over the conversation.** Comments sent from `/annotate` aren't lost: each reaches Claude as a prompt and stays in the session (and `--resume`). What disappears is the anchor, so after sending nothing shows which parts were commented on or how Claude answered each. On `/annotate`, find earlier sent prompts in `$.session.messages()` by their format ("I left N comments… On this part: > quote"), locate each quote in the conversation text, and draw those comments as dimmed highlights next to the new ones. No separate storage, so nothing to keep in sync, and it lives and dies with the session. Weak spot: a quote that appears in more than one place.
- [ ] **Later, threads:** a comment, Claude's answer, a follow-up on the same spot, and a resolved state, as in a PR review.
- **Not planned:** storing comments across sessions (`$.store`). A conversation doesn't outlive its session; comments on lasting artifacts (a PR, a doc) belong on the artifact.

Every layout tried on Claude Code 2.1.286 (a cursor on the main transcript, a thin key pane, a floating overlay, and the wide pane chosen), with the requirements and the API limits behind each, is in [`docs/layout-approaches.md`](docs/layout-approaches.md). The test mod is in `spikes/transcript-layouts/`, so the same tests can be rerun on a newer version.

## License

MIT. See [LICENSE](LICENSE).
