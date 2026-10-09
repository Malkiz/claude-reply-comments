# claude-reply-comments

A Claude Code mod for commenting inline on parts of Claude's last reply, the way a PR review or Notion comments work. All the comments then go back to Claude as one prompt.

Requires Claude Code with mods (function hooks): 2.1.286 or later. Built for the terminal (tmux on macOS), and it also draws in the desktop Code tab.

## Use

`/annotate` opens a pane with Claude's last reply and gives it the keyboard. The keys are vim's. `?` shows or hides the full key list at the bottom of the pane. It starts hidden every time.

| Group | Keys |
| --- | --- |
| Move | `h j k l` · `w b e ge` (`W B E gE`) · `0 ^ $` · `gg G` (`5G` goes to line 5) · `{ }` · `H M L` · `f t F T ; ,` · counts (`3j`, `2w`) · `ctrl-d ctrl-u ctrl-f ctrl-b ctrl-e ctrl-y` after clicking the reply |
| Select | `v` · `V` · `o` swaps ends · text objects `iw aw iW aW is as ip ap i( a( i[ i{ i< i" i' i\``… |
| Comment | `c` on a selection · `c{motion}` comments that span: `cip ciw ci( cc c$ c2e`… · `o` overall comment · `r` revise / `x` delete the comment under the cursor · `]c` `[c` next/prev comment |
| Search | `/text` then Enter (smartcase) · `n N` |
| Finish | `s` send · `:w` send · `:p` put the prompt in the prompt box · `:clear` · `q` / `:q` close (the draft is kept) · `:12` go to line 12 · `zz zt zb` scroll |

`c`, `o`, `r`, `/` and `:` open a field at the bottom with the keyboard in it. Enter finishes. Esc cancels. An empty comment cancels, or removes the one you're revising.

Esc never takes you out of the pane: it leaves visual mode, a field or a half-typed command, and does nothing in normal mode. `q` closes the pane.

With the mouse, drag over text to select it and start a comment. Clicking the reply also hands it the keyboard directly, which adds the ctrl keys. In that case the comment is typed in place and `ctrl-c` cancels it.

The prompt quotes each selected span, with its comment under it, in reply order.

## Install

Load the folder as a plugin:

```sh
claude --plugin-dir ~/malkiz/github/claude-reply-comments
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the `/annotate` command, the pane, its key field, field and legend, Esc, sending and filling the prompt.
- `hooks/reader.tsx`: the `Client` surface module that draws the reply and handles mouse and keys.
- `hooks/vim.ts`: the vim engine: motions, operators, modes.
- `hooks/lib.ts`: wrapping, word/paragraph/text-object primitives, prompt building and the legend.
- `types/index.d.ts`: the `$.state` contract.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod. That folder is gitignored.

### How the keyboard reaches the reader

A `Client` gets keys only after a click. So the pane draws an `Input` (the key field) that holds the keyboard. Each change is handed to the reader through `$.state` (`relay`, applied once each by `seq`), and the field is redrawn with a new zero-width mark so it never fills up. Ctrl keys don't reach an `Input`, which is why they need the click.

The pane is opened with `closeOnEscape`, so Esc arrives as a `ui.close` the mod refuses, handing the reader an `escape` and taking the keyboard back with a delayed `$.ui.open({ focus })`. The same delayed open gives the pane the keyboard after `/annotate`, because a `focus` request made inside the command is refused.

Every row in the pane is exactly one cell tall, and the reader's height is the pane's body less the legend and the field. Nothing the reader draws can push the layout around.

The vim engine is `hooks/vim.ts`: pure functions, tested in `tests/vim.test.ts`.
