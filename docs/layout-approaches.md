---
title: Where the annotation UI can live in Claude Code, and what each approach cost
date: 2026-10-10
tags: [claude-code, mods, design, api-limits]
---

# Where the annotation UI can live in Claude Code, and what each approach cost

A record of every layout tried for this mod (`/annotate`): the requirements, how each approach tried to meet them, and the exact API facts that blocked it. It's written for re-testing: when Claude Code's mods API changes, compare it against the "would unlock it" lines below and try again.

## Versions this was tested on

- **Claude Code 2.1.286** (Homebrew cask, macOS, Darwin 24.6.0). Mods (function hooks) were already on, although the changelog says they arrived in 2.1.287.
- **API reference:** the `claude-code.d.ts` that the `plugin-authoring` skill writes for this build (about 14,500 lines), plus its `reference.md`. Every type name below comes from that file. To check a newer build, load the skill and grep its `types/claude-code.d.ts` for those names.
- **Test setup:** interactive Claude Code in a detached tmux session (120×40 and 140×45), fullscreen layout (`isFullscreen: true` in `command.run`'s `presentation`), driven with `send-keys`. Mouse input was injected as SGR escape sequences.
- **The spike mod** that ran these tests is in [`spikes/transcript-layouts/`](../spikes/transcript-layouts/) (`/tcursor`, `/tkeys`, `/tfull`, `/tover`).

## The goal

Select specific parts of the conversation, attach a comment to each, and send them all back to Claude as one prompt that quotes each part with its comment. That loop is the point of the mod. Everything else serves it.

## Requirements

1. **Annotate and send:** comments on exact spans, sent as one prompt that quotes each span with its comment.
2. **The whole conversation:** any message, as far back as wanted. Version 0.1–0.3 covered only Claude's last reply.
3. **Looks like the main view:** the conversation as close as possible to how the transcript already draws it, with annotation added on top.
4. **Scrolling:** the mouse wheel and the keyboard, anywhere in the conversation. The view follows the cursor.
5. **Click and drag:** drag over text to select it and start a comment.
6. **Vim control:** real vim motions, operators, text objects, counts and search. Esc behaves as in vim: it leaves visual mode or cancels, and doesn't throw you out.
7. **Keyboard focus without a click:** after `/annotate` the keys work immediately.
8. **Stable layout:** the key list shown on demand, and no text jumping around as the cursor moves.
9. **Back to normal when done:** closing returns to the usual main view.

## Approaches at a glance

| Approach | 2 whole convo | 3 looks like main view | 4 scrolling | 5 drag | 6 vim + Esc | 7 no click | Outcome |
|---|---|---|---|---|---|---|---|
| A. Side pane, last reply | no | no | yes | yes | yes | yes | Shipped v0.1–0.3 |
| B. Cursor on the transcript, keys from the band above the prompt | yes | yes | yes | no | no Esc | no | Blocked by focus and Esc |
| C. Cursor on the transcript, keys from the prompt box | yes | yes | wheel only | no | no Esc, no ctrl keys | yes | Blocked by scroll and Esc |
| D. Thin docked pane as key catcher + cursor on the transcript | yes | yes | yes | no | yes | yes | Viable, not chosen |
| E. One-line pane above the prompt | — | — | — | — | — | — | Not possible in fullscreen |
| F. Wide docked pane drawn like the transcript | yes | close | yes | yes | yes | yes | **Chosen, v0.4** |
| G. Floating overlay over the transcript | yes | close | breaks on wheel | probably not | needs D for Esc | with C only | Blocked by the wheel |

## A. Side pane with the last reply (v0.1–0.3)

- **How:** `/annotate` opens a `Pane` (`$.ui.open`). A `Client` surface module draws the reply and handles the mouse. An autofocused `Input` (the key field) catches every printable key and relays it to the `Client` through `$.state`.
- **What worked:**
    - Focus after `/annotate`: open in `command.run`, then `$.ui.open({ focus: true })` again from `$.clock.after(300)`. A `focus` request inside the command is refused.
    - Esc: open with `closeOnEscape`; Esc arrives as `ui.close` with origin `person`, which the hook refuses before taking the keyboard back.
    - Wheel: `ui.scroll` on the pane, relayed to the reader.
    - Drag: `ClientPointerEvent` on the `Client`.
- **Limits:**
    - Only the last reply.
    - Ctrl keys never reach an `Input`, so `ctrl-d` and friends need a click on the `Client`.
    - A `Client` gets keys only after a click on it.

## B. Cursor on the main transcript, keys from the band above the prompt

- **How:** `ui.render` hooks on `AssistantMessage` and `UserMessage` redraw any message with a cursor cell. The `AbovePrompt` band holds the key field `Input`. Each move calls `$.ui.scroll({ to: { requestId } })` to bring the message into view.
- **What worked:**
    - Redrawing any message, not only the last one.
    - Redraw time 5–12ms per key.
    - `$.ui.scroll` on transcript messages was allowed from the band's `Input`.
    - The band kept focus through mouse-wheel scrolling.
- **Blockers:**
    - **Focus:** `$.ui.focus({ requestId: 'above-prompt', key })` from `command.run` was denied: "that site does not hold the keyboard". The band takes the keyboard only after a click or `ctrl+x tab`.
    - **Esc:** Esc in the band returns the keys to the prompt box, and no `ui.focus` event fires for it, so a hook can't refuse it.
    - **Formatting:** a redrawn message is plain text with styles. The engine's markdown drawing is a leaf (`Markdown`), so it can't be highlighted inside. Markdown is lost while annotating unless the mod re-renders it.
    - **Drag:** a `Client` is "one instance per plugin", so it can't sit inside every message.
    - **Message order:** `$.session.messages()` carries no message ids, so the order of rendered messages has to be inferred by matching text.
- **Would unlock it:**
    - `$.ui.focus` able to take the band's keyboard from a command.
    - Esc in the band arriving as an event a hook can refuse.
    - Highlight ranges on a transcript message's own drawing; `PromptDecoration` does this for the prompt box only.

## C. Cursor on the main transcript, keys from the prompt box

- **How:** a `prompt.edit` hook swallows every edit in the main prompt box (answer `{ text: e.text, cursor: e.cursor }` without `next`) and treats `e.key` as a vim key. Drawing is the same as B.
- **What worked:** no focus problem at all; keys work right after `/annotate`.
- **Blockers:**
    - **Keys that arrive:** letters and symbols, `ctrl-u`, left arrow, backspace.
    - **Keys that don't:** `ctrl-d`, `ctrl-e`, Tab, Up (it recalls history), and Esc (the engine shows "Esc again to clear").
    - **Scrolling:** `$.ui.scroll` from this route is denied, "not person-initiated". `G`, `gg`, search and moving past the screen edge leave the cursor off screen. Only the wheel scrolls.
- **Would unlock it:**
    - `ui.scroll` on transcript rows counting a `prompt.edit` key as the person's input.
    - Esc and the ctrl keys reaching `prompt.edit`.

## D. Thin docked pane as key catcher, cursor on the transcript

- **How:** A's focus and Esc handling in a narrow pane that holds only the key field, driving B's transcript cursor.
- **What worked:**
    - Focus without a click.
    - Keys arrive through `Input` `onInput`.
    - `$.ui.scroll` on transcript messages was allowed.
    - Esc handling as in A.
- **Costs:**
    - In fullscreen at 110+ columns a pane always docks beside the transcript, floor to ceiling. `columns: 14` and `columns: 30` were ignored; it opened 74 wide. Dragging the divider worked, and the narrowest it went was 23 columns.
    - Drag-to-comment and markdown formatting are still lost, as in B.
- **Status:** viable. Passed over for F, which keeps drag-to-comment.

## E. One short, wide pane line above the prompt

- **Asked for:** a one-line pane above the prompt box, used only to type keys.
- **Why not:** the surface places a pane (`Pane` props `placement: 'dock' | 'inline'`). It docks in the fullscreen layout from 110 columns and goes inline above the prompt only on the main screen or a narrower terminal. On the main screen, older messages are printed into scrollback and can't be redrawn, which kills requirement 2. No `PaneOpenArgs` option picks the placement.
- **Would unlock it:** a placement option on `$.ui.open` (inline or bottom in fullscreen).

## F. Wide docked pane drawn like the transcript (chosen, v0.4)

- **How:** A's pane, with the reader showing the whole conversation instead of the last reply:
    - `conversation()` lays out every prompt, reply text block and tool call, a blank line apart, from `$.session.messages()`.
    - The reader draws the transcript's `❯` / `⏺` gutter (tool calls as `Bash(ls)` with a `⎿` first result line).
    - `renderMarkdown()` draws headings and bold, and tints code. The markers are hidden; offsets map to the rendered text.
    - It opens at the bottom with the cursor on the last reply.
    - The prompt names the message each comment is on when any is outside the last reply.
- **Meets:** every requirement. "Looks like the main view" is approximate: the mod re-renders markdown itself, and tool calls show expanded where the main view collapses them ("Ran 1 shell command").
- **Costs:**
    - **Dock width:** a single value for all panes, kept in Claude Code's own global config as `pluginPanes.dockColumns`. Once the person has dragged it, the mod's `columns` request is ignored; the pane opens at whatever was last dragged.
    - **Maximum width:** the widest was a 95-column pane body in a 120-column terminal. The transcript keeps at least 24 columns, so a squeezed strip of the real conversation stays visible beside the pane.
    - **Ctrl keys:** still need a click on the conversation, as in A (solved for four keys in v0.5.3, see the next-but-one section).
- **Would improve it:**
    - A `columns` request that wins for this pane only.
    - A maximised or full-width pane mode.
    - The engine's own transcript row drawing available to a pane.

## G. Floating overlay over the transcript

- **How:** a `Box` with `position="absolute"` paints over its surroundings, "clipped by the region its site is in (viewport, pane, band)". It's drawn from the transcript's last row (the command's own `CommandOutput` row) with `bottom={0}`, the viewport's height and every line space-padded to full width.
- **What worked:**
    - It covered the whole conversation area cleanly.
    - Drawn from an earlier message instead, the rows after it paint over it (later siblings win), so it has to be the last row.
- **Blockers:**
    - **Wheel:** the overlay is attached to the scrolling transcript. The wheel scrolls the real conversation and the overlay slides away ("Jump to bottom" brings it back). `ui.scroll` covers only `Pane` and `AbovePrompt` (`UiScrollComponent`), so no hook can stop transcript scrolling.
    - **Keys:** it can't hold the keyboard. Keys come from C (no Esc) or D (a docked pane beside it).
    - **Drag:** the docs say the pointer on an absolute Box "is on its parent", so a `Client` inside it probably gets no drags. Untested.
- **Would unlock it:**
    - A true floating or modal pane.
    - A hook on transcript scrolling.
    - An overlay site that isn't attached to a transcript row.

## Ctrl keys through keybinding buttons (v0.5.3)

- **Problem:** the key field is an `Input`, and ctrl keys never reach one, so `ctrl-e` and friends worked only after a click on the reader.
- **How:** the pane draws hidden `Button`s (a `Box` with `height={0}` and `overflow="hidden"`, placed after the reader) whose `action` names an engine keybinding action: `select:next`, `select:previous`, `select:pageDown`, `select:pageUp`. The person binds `ctrl+e` `ctrl+y` `ctrl+f` `ctrl+u` to them in the `PaneField` context of `~/.claude/keybindings.json`. Each press relays the key to the reader with `ctrl: true`.
- **Why it works:**
    - Ctrl-modified keys still run keybindings while a text field has focus (keybindings docs, "Text fields").
    - A Button's `action` is pressed by the person's binding when it's a modified key in an active context and no engine handler of that action is mounted. No engine list is open while the pane has focus, so the `select:*` actions are free.
    - `PaneField` is active only while a mod pane's field has the keyboard, so the prompt keeps its own `ctrl-e`.
- **Costs:**
    - **Comment field:** a binding takes the key before the field does, so with the buttons drawn, `ctrl-e` in the comment field stopped jumping to the end (checked live: "hello Xworld" instead of "hello worldX"). Since v0.5.6 the buttons aren't drawn while a comment is typed, and the field keeps its own `ctrl-e` (checked live).
    - **No `ctrl-d`:** Claude Code reserves it. Even after a click it returns the keyboard to the prompt (checked live, v0.5.5). `ctrl-f` (a whole screen down) takes its place.
    - **No `ctrl-b`:** it's the usual tmux prefix and never reaches Claude Code inside tmux.
- **Tested:** live on 2.1.287 in a detached tmux session (160×45): `ctrl-e` ×3 moved the cursor from line 1 to 4, `ctrl-f` to 39, `ctrl-u` back to 20.
- **Would simplify it:** ctrl keys delivered to an `Input`, or a way for a mod to declare its own keybinding actions.

## API facts worth re-checking on a new version

| Fact on 2.1.286 | Where it's stated | Blocks |
|---|---|---|
| `UiFocusComponent = 'Pane' \| 'AbovePrompt'`; the band takes the keyboard only after a click or `ctrl+x tab` | `UiFocusArgs`, `AbovePrompt` props | B |
| Esc in the band returns the keys with no refusable event | observed; `ui.focus` deny never ran | B |
| `$.ui.scroll` reveals a transcript row "only while this call answers the person's own input"; denied from `prompt.edit` | `UiScrollArgs` | C |
| `prompt.edit` gets no Esc, `ctrl-d`, `ctrl-e`, Tab or Up | observed | C |
| A pane docks in fullscreen from 110 columns; no placement option | `Pane.placement`, `PaneOpenArgs` | E |
| Dock width is one remembered value; a dragged width beats `columns` | `PaneOpenArgs.columns`; Claude Code's global config, `pluginPanes.dockColumns` | D, F |
| A `Client` is one instance per plugin; it gets keys only after a click | `Client` element docs | A, B |
| Ctrl keys never reach an `Input` (worked around with keybinding buttons, v0.5.3) | observed | A, F |
| `ui.scroll` covers only `Pane` and `AbovePrompt` | `UiScrollComponent` | G |
| An absolute `Box` is clipped to its site's region; the pointer on it goes to its parent | `BoxProps.position` | G |
| `Markdown` is a leaf; a message can't be highlighted inside the engine's own drawing | `RenderElement` | B, C, F |
| `$.session.messages()` has no message ids | `SessionMessage` | B, C |
| A `Client`'s props may serialize to at most 100,000 characters; past that the whole pane tree is refused and an empty pane is drawn | `ClientElements` bounds; observed: "Client \"reader\" props serializes to more than 100000 characters" | F (handled in v0.4.1 by handing the reader a window of the conversation) |

## Related

- [README](../README.md): how the chosen layout works, and the ideas not built yet.
