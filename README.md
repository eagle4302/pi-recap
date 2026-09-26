# @eagle4302/pi-recap

A Grok-style **recap block** appended to the end of every reply in the [pi coding agent](https://pi.dev).

```
⏺ Recap · deepseek/deepseek-flash
  - Fixed the null deref in lib/router.ts:88 by guarding on the session token.
  - Added test/smoke.mjs coverage for the queued-run path (24 tests, all green).
  - Still open: /recap on|off is not persisted across restarts.
```

Each exchange gets its own block at the end of the transcript, written by a
cheap model in the background. It reads like part of the conversation, and
because it is a **custom entry** it never enters the LLM context — the main
model's prompt stays exactly as it would be without this extension.

## Install

```bash
pi install npm:@eagle4302/pi-recap     # writes to ~/.pi/agent/settings.json
pi -e npm:@eagle4302/pi-recap          # or try it for one session, without installing
```

Use `--local` to install into the project (`./.pi/settings.json`) and
`pi remove npm:@eagle4302/pi-recap` to uninstall.

## Usage

Everything is automatic: when an exchange settles, a recap is written and
appended. The same exchange is never recapped twice.

| Command | What it does |
| --- | --- |
| `/recap` | Write a recap of the current exchange right now |
| `/recap on` / `/recap off` | Turn automatic recaps on or off (session only) |
| `/recap model <provider>/<model>` | Pin the recap model, e.g. `/recap model openai/gpt-5-mini` |
| `/recap model auto` | Go back to automatic model selection |
| `/recap status` | Show the current settings and the model that would be used |

## Which model writes the recap

By default the extension asks pi for the models you have credentials for and
picks the **cheapest one that can do the job**: it must accept text and have a
context window of at least 16k tokens, and it is scored by
`cost.input + 4 × cost.output` per million tokens (output is weighted heavier
because the transcript is long on the way in and short on the way out).

If nothing qualifies, an automatic recap warns once per session and stays quiet
after that. Pin a model with `/recap model …` if you would rather choose.

## Requirements and limits

- The pi coding agent, in **interactive (TUI) mode**. Recaps render into the
  transcript, so print/JSON/RPC runs never summarise automatically (`/recap`
  still works if you ask for it).
- One extra model call per exchange, with a truncated transcript (max 12k
  characters, tool output capped). Failed and aborted turns are skipped.
- Settings (`on`/`off`, the pinned model) live for the session only; the
  default is always "on, automatic model".

## Privacy

The exchange transcript — the user message, assistant text, tool calls, and
truncated tool output from that exchange — is sent to whichever model you
configured or pinned, and to nobody else. The extension has no telemetry, no
network code of its own, and no dependencies beyond pi itself.

## Development

```bash
npm test          # loads the real extension with pi's TS loader, 24 checks
npm run verify    # pre-publish checks: metadata, shipped files, privacy, policy
```

`npm test` needs a pi installation; it looks at `$PI_PACKAGE_DIR`, then
`./node_modules`, then the usual global npm locations.

## License

MIT. Not affiliated with xAI or Grok — the recap block is inspired by Grok CLI's.
