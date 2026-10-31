# Changelog

## 0.5.3 — 2026-10-31

Simplify installation documentation and remove migration notices. CLI behavior is unchanged.

## 0.5.2 — 2026-10-31

Restore the project name `resume-session` and the npm package `@pranciskusj/resume-session`. The executable remains `resume`; session and subagent recovery behavior is unchanged.

## 0.5.1 — 2026-10-31

Package metadata and installation documentation updates. Includes all four-platform recovery features from 0.5.0.

## 0.5.0 — 2026-10-31

The npm package is now named `@pranciskusj/resume-session`; the executable remains `resume`. Subagent recovery now supports all four source platforms: Claude, Codex, Gemini and OpenCode. The README is shorter, with plain terminal-window examples and a tagline covering account and coding-agent switching.

- Codex child-thread relationships, active/archived rollouts, dispatches and follow-up assignments; inherited ancestor records are filtered to avoid duplicate dispatches.
- Gemini nested subagent JSON/JSONL histories, including journal patches, checkpoints and rewinds.
- OpenCode child sessions from read-only SQLite snapshots (including WAL and newer message tables) and legacy JSON stores.
- A normalized coordinator archive for non-Claude sources preserves parent context when the upstream conversation parser lacks newer records.
- Worker packets in all twelve cross-agent directions, with missing-context warnings and no credential or process transfer.


## 0.4.2 — 2026-10-31

Promoted Claude subagent recovery in the headline, introduction and package description. Clarified that saved assignments, transcripts and task relationships help the destination agent recreate unfinished workers; running processes and in-memory state do not transfer. CLI behavior is unchanged.

## 0.4.1 — 2026-10-31

Updated the tagline and package description to focus on continuing sessions in another agent after hitting usage limits. Removed the screenshot explanation paragraph from the README. CLI behavior is unchanged.

## 0.4.0 — 2026-10-31

First public release, with npm installation, a GitHub release package, worked examples and five reproducible images using fictional session data.

- Folder-scoped selection across Claude Code, Codex, Gemini CLI and OpenCode.
- Discovery across local history roots, including histories from previous account logins.
- Native same-store resume and portable cross-agent handoffs with conversation archives.
- Shell alias detection, original-alias execution and forwarding of extra target flags.
- Claude worker recovery packets with assignments, nested task relationships, transcript snapshots and missing-context warnings.
- `--prepare` for inspecting context without launching an agent; `--dry-run` for launch arguments without writes.
- Packed installation and behavior checks across macOS, Linux and Windows on Node 22 and 24.

## 0.3.0

Added Claude worker recovery bundles and preparation without launching.

## 0.2.0

Added alias discovery, flag forwarding and account-switch selection coverage.

## 0.1.0

Initial private prototype with four-agent parsing and project-scoped selection.
