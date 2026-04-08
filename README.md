# pi-claude-btw

`pi-claude-btw` adds a Claude Code-style `/btw` command to Pi.

It opens an overlay immediately, forks a separate one-shot Pi subprocess, feeds it the current branch transcript, and shows the side answer without writing anything into the main session transcript.

## What it does

- registers `/btw <question>`
- captures the current branch conversation from `ctx.sessionManager.getBranch()`
- starts a separate `pi --mode json --no-session --no-tools` worker
- streams the side answer into an overlay
- supports `Esc` to cancel while running
- keeps results ephemeral by default

## Install

Project-local:

```json
{
  "extensions": [
    "/absolute/path/to/pi-claude-btw"
  ]
}
```

Or copy/link the package into one of Pi's extension discovery locations.

## Usage

```text
/btw what are you doing?
```

Controls:

- `Esc` while running: cancel and close
- `Up` / `Down`: scroll long output
- `S` after a successful answer: send the result back to the main session as a follow-up
- `Enter`, `Space`, or `Esc` after completion: dismiss

## Notes

- This aims to be close to Claude Code's `/btw`, but Pi extensions cannot reuse Claude Code's internal cache-safe provider payload snapshot byte-for-byte.
- The current implementation serializes the current branch into a transcript and passes that transcript to the side-question worker.
- Sending the result back is explicit and opt-in; the overlay stays ephemeral unless you press `S`.
- The worker runs without built-in tools, extensions, skills, prompt templates, or themes.
