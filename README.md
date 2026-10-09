# claude-reply-comments

A Claude Code mod for commenting inline on parts of Claude's last reply, the way a PR review or Notion comments work. All the comments then go back to Claude as one prompt.

Requires Claude Code with mods (function hooks): 2.1.286 or later. Built for the terminal (tmux on macOS), and it also draws in the desktop Code tab.

## Use

`/annotate` opens a pane with Claude's last reply and gives it the keyboard. No click is needed. Every key is listed at the bottom of the pane. A short pane switches to a compact legend with shorter labels.

| Group | Keys |
| --- | --- |
| Move | `j` down · `k` up · `h` left · `l` right · `w`/`b` next/prev word · `n`/`p` next/prev paragraph · `d`/`u` page down/up · `g` top · `e` end |
| Select | `v` start/stop a selection · `a` select the paragraph |
| Comment | `c` comment on the selection (or the paragraph) · `o` overall comment · `r` revise / `x` delete the comment under the cursor · `m` next comment |
| Finish | `s` send all as one prompt · `f` put the prompt in the prompt box · `z` clear all · `q` close (keeps the draft) |

After `c`, `o` or `r`, a comment field opens at the bottom with the keyboard in it. Type and press Enter. An empty comment cancels, or removes the comment you're revising.

With the mouse, drag over text to select it and open a comment. Clicking the reply also hands it the keyboard directly, with the same keys plus arrows, and you type the comment in place.

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

- `hooks/register.tsx`: the `/annotate` command, the pane, its key legend and comment field, sending and filling the prompt.
- `hooks/reader.tsx`: the `Client` surface module that draws the reply and handles mouse and keys.
- `hooks/lib.ts`: wrapping, selection, prompt building and the keymap.
- `types/index.d.ts`: the `$.state` contract.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod. That folder is gitignored.

### How the keyboard reaches the reader

A `Client` gets keys only after a click. So the pane draws every key as a hotkey `Button`, and a press is relayed to the reader through `$.state` (`relay`, applied once each by `seq`). Comment text goes through an `Input`, which `$.ui.focus` targets. The pane opens inside the command (so it is placed at any width), then asks for focus again from a timer once the command has finished. A `focus` request made inside the command itself is refused.
