# @juicesharp/rpiv-ask-user-question

> **Local fork — not upstream.** Copy of `@juicesharp/rpiv-ask-user-question` 2.15.0, loaded from
> `~/.pi/agent/extensions/rpiv-ask-user-question/` (the npm package was removed from
> `~/.pi/agent/settings.json` so only one `ask_user_question` registers). Differences from upstream:
>
> 1. **Flow layout, no dialog box** — the top and bottom borders are gone; every row is prefixed with an
>    accent `┃` gutter, so the questionnaire reads as a block in the conversation rather than a popup.
>    Row counts are unchanged, so overflow and scrolling behave exactly as upstream.
> 2. **Answers stay in the transcript** — on submit or cancel the questionnaire is written back as a
>    custom entry (`ask-user-question`, never part of the LLM context): the question, the chosen answer,
>    notes and attached image paths. Turn it off with `recordTranscript: false`.
> 3. **Clipboard attachments** — `Ctrl+V` while a text field has focus inserts clipboard file paths
>    (Finder copies), or writes a clipboard image to `pi-clipboard-<uuid>.<ext>` in the temp directory and
>    inserts that path. The path rides in the answer text; the model opens it with `read`.
> 4. **Chat mode on RPC hosts** — opt-in only (`chatMode: "auto"` or `"always"`). Pi Desktop runs `pi`
>    over RPC, where `ui.custom()` returns `undefined` and the stock dialogs have no image channel. With chat
>    mode on, the questions are posted into the conversation as a message instead of a popup; the user answers
>    in the composer and attaches images natively. See `state/chat-prompt.ts`. The default (`"off"`) keeps the
>    dialogs, which now carry the rich card + attachments when the Pi Desktop patch is installed.
> 5. **Rich dialog support on RPC hosts** — `rpc-fallback.ts` understands the `{"__piRich":1,...}` envelope
>    (chosen option + typed answer + skip + attachment paths) and emits `label` / `description` as two lines so
>    patched clients can render them as a title and a subtitle. Plain-string hosts are unaffected. The client
>    half lives at `~/Desktop/工作/pi-desktop-patch/` (`apply.sh`, `rollback.sh`, `rich_dialog.js`).
> 6. **Stepper navigation and checkbox options on RPC hosts** — `rpc-fallback.ts` is a stepper instead of a
>    one-way loop. Every dialog title ends with a plain-text `[Q i/n #session M?]` marker; `M` marks a
>    multi-select question. The patched pi-web card parses it and renders a step chip, `← 上一题` /
>    `下一题 →` buttons, radio circles and checkbox squares. Back returns `{"__piRich":1,"nav":"back"}`;
>    plain hosts type `/back`. Multi-select uses `ui.select` plus a `{"__piRich":1,"selected":[...]}`
>    envelope instead of a free-text numbers input, so no question is input-only. Answers are held in a
>    `Map` keyed by `questionIndex`; empty replies re-ask the current question. The last question submits
>    directly — there is no review card. The client half lives at `~/Desktop/工作/ask_question/`
>    (`rich_dialog_web.js`, `apply.py`, `verify.js`, `verify-rpc.js`).
>
> Re-sync procedure after an upstream release: re-copy the package into this directory, re-apply the changes
> above (files: `rpc-fallback.ts`, `view/dialog-builder.ts`, `view/transcript-entry.ts`,
> `state/clipboard-image.ts`, `state/questionnaire-session.ts`, `ask-user-question.ts`, `config.ts`,
> `view/dialog-copy.ts`, `view/tab-content-strategy.ts`), and keep this `package.json`.


[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover: a tabbed terminal questionnaire asking Which real development task are we planning right now?, with numbered options — Bug fix, New feature, Refactor — each under a one-line description, and a footer of key hints" width="50%">
  </a>
</div>

Let the model ask you instead of guessing. This extension gives [Pi Agent](https://github.com/badlogic/pi-mono) one tool — `ask_user_question` — that opens a terminal dialog of up to four questions with written-out options, and hands your choices back as structured data. Install it if you would rather spend fifteen seconds picking than an hour undoing a wrong assumption.

## Install

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart your Pi session.

## Quick start

Nothing to set up — the tool is live as soon as Pi restarts. Hand the model a task with a real decision buried in it:

> Add caching to the API client.

Rather than picking a strategy on your behalf, the model calls `ask_user_question` and a dialog takes over the bottom of your terminal. Move with `↑`/`↓`, choose with `Enter`, press `n` to attach a note to a question or a global note from the Submit tab, or land on `Type something.` to answer in your own words. In a multi-select question, typed custom text is selected automatically and submitted together with checked options. While typing, `Shift+Enter` adds a line, `Ctrl+G` opens Pi's configured external editor, and `Ctrl+U` clears the draft; browsing another option and returning keeps what you wrote. `Esc` abandons the questionnaire entirely.

When the questionnaire begins waiting in an interactive TTY, it emits one standard terminal BEL (`\x07`). Your terminal configuration determines whether that appears as an audible alert, a visual alert, or nothing; redirected and non-TTY output is untouched.

![Single question in the dialog: the tab strip reads Feature Type, Design Tab, Testing, Release, Submit; the question Which real development task are we planning right now? sits above four numbered options — Bug fix (Recommended), New feature, Refactor, Perf tuning — each with a one-line description, followed by the appended Type something. row](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg)

When the model asks several things at once, `Tab` moves between them and a Submit tab reviews everything before it goes back:

![Submit tab of a four-question dialog: a Review your answers list showing Feature Type set to Bug fix and Testing set to Unit tests plus Integration tests, a warning naming Design Tab and Release as still unanswered, a picker offering Submit answers or Cancel, and a dim bottom key-hint row including n to add a note](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg)

## What you get

- **Typed options instead of a wall of prose** — each question carries 2-4 authored choices, and every choice comes with a description of what it means or what it costs you.
- **You can always answer in your own words**. A `Type something.` row is appended to every question. On multi-select questions, it keeps checked options and custom text in the same answer. The row widens to the full pane while you type, keeps its multiline draft visible while you browse, and supports Pi's `Shift+Enter` newline and `Ctrl+G` external-editor flows.
- **Compare real artifacts, not just labels** — an option can carry a markdown `preview` (ASCII mockup, code, diagram, config) that renders in a bordered box beside the option list.
- **One interruption, not five** — up to four questions arrive in a single tabbed dialog, and the Submit tab lists your answers and names anything still blank before you commit.
- **Notes on any answer — or on all of them** — `n` opens a multiline note editor on any question tab, and on the Submit tab it opens one global note for the whole questionnaire. Per-question notes reach the model as `user notes: <text>`, the global note as `global note: <text>`; neither marks a question answered.
- **Keep reading while you answer** — the question opens below the transcript, and `PageUp`/`PageDown` or the mouse wheel keep scrolling the conversation; `Ctrl+]` shrinks the dialog to one line when you want more room, then brings it back with your answers intact.
- **Works outside the terminal too** — in RPC and ACP hosts such as the VS Code pendant or Zed the questionnaire walks through the host's native dialogs (notes are terminal-only and do not carry over), and in non-interactive runs the tool is removed from the model's tool list instead of failing every call.

## Configuration

Optional. Settings live in `~/.config/rpiv-ask-user-question/config.json`; the file is read, never written.

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog. Accepts Pi keybinding ids such as `alt+o`; `"off"` disables the shortcut. | `"ctrl+]"` |
| `notesKey` | Key that opens the notes editor. Any single character, including non-Latin ones such as `т`, or a Pi keybinding id such as `ctrl+n`. | `"n"` |
| `recordTranscript` | Local fork: write the answered questionnaire into the chat transcript as a custom entry. `false` keeps the transcript clean. | `true` |
| `chatMode` | Local fork: `"off"` keeps the one-dialog-per-question popups, with back/next navigation on multi-question runs (default). `"auto"` posts the questions into the conversation on RPC hosts (Pi Desktop) and keeps the dialog on terminals; `"always"` uses the conversation everywhere. | `"off"` |
| `guidance.description` | Full replacement for the tool description the model sees. A non-empty string replaces the built-in text entirely — no merging. | built-in description |
| `guidance.promptSnippet` | One-line description of the tool in the system prompt — tune how eagerly the model asks. | built-in snippet |
| `guidance.promptGuidelines` | Usage guidelines given to the model, as a list of strings. | 4 built-in guidelines |

```json
{ "collapseKey": "alt+o" }
```

Malformed JSON falls back to the defaults with a warning; an individual unusable value is silently dropped back to its default. Never an error.

## Reference

- [Tool schema](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/tool-schema.md) — parameters, limits, reserved labels, validation errors, the result envelope, and the `rpiv:ask-user:prompt` event.
- [Keyboard and layout](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/keyboard.md) — every key, the rows the dialog appends, notes, collapse mode, and how previews and overflow adapt to terminal size.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/configuration.md) — file lookup and `XDG_CONFIG_HOME`, the `collapseKey` grammar, the `guidance.*` prompt overrides, and how invalid values are handled.
- [Hosts and runtime behavior](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/hosts.md) — terminal vs RPC vs non-interactive, what degrades in each, and the load-failure envelopes.
- [Localization](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/localization.md) — the nine shipped languages, how the locale is chosen, and how to add one.

## Requirements

- Node.js 22 or newer.
- Pi Agent, with an interactive terminal or an RPC/ACP host. Non-interactive runs never see the tool.
- A terminal at least 100 columns wide for side-by-side previews; narrower terminals stack the preview under the options.

No native dependencies, no compiler, no API keys — the extension makes no model calls of its own.

## Troubleshooting

**The model says the questionnaire UI failed to load and asks its questions as chat text.** The dialog's modules were replaced on disk while Pi was running, usually by a package-manager install touching the store. Repair the install if it is broken, then restart Pi; the failure is not recoverable inside the running process.

**`Ctrl+]` does nothing.** On keyboard layouts where `]` sits on the shifted layer (Latin American among them) the default is unreachable. Set `collapseKey` to something you can type, for example `"alt+o"`.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — optional; installing it renders the dialog chrome in your language and adds `/languages`.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — the umbrella package whose workflow skills use `ask_user_question` as their developer checkpoint. `/rpiv-setup` offers to install this extension.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/LICENSE).
