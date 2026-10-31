# Subagent recovery

During a handoff, resume recovers saved delegated work from **Claude Code, Codex, Gemini CLI and OpenCode**. The destination receives a common recovery inventory and per-worker context. It can recreate unfinished workers with its own tools or continue sequentially.

```sh
resume codex --session SOURCE_SESSION_ID --prepare
```

Use an ID from `resume list --json`. `--prepare` writes the bundle without starting an agent. Ordinary cross-agent handoffs prepare it automatically. Same-agent, same-store native resume is unchanged; `--handoff` forces a portable bundle when wanted.

## Supported saved formats

| Source | Relationships and context recovered |
| --- | --- |
| Claude | `Agent` / `Task` dispatches, tool results, task notifications and the session's `subagents/*.jsonl` histories, including nested workers. |
| Codex | Parent-thread metadata, spawn and collaboration events, spawn results, follow-up assignments and rollouts under `sessions/` and `archived_sessions/`. Matching inherited ancestor records are excluded from child snapshots to avoid duplicate dispatches. A normal user fork is not automatically treated as a subagent. |
| Gemini | Subagent conversations in the main session's chat directory, tool-call `agentId` links and recognizable delegation calls. Supports JSON and JSONL journals, including message patches, metadata checkpoints and rewinds. Explicit tool links distinguish nested workers even when files share the main session directory. |
| OpenCode | Child-session `parent_id` / `parentID` links and `task` results. Reads SQLite `message` / `part` tables or newer `session_message` records in a read-only transaction, including WAL contents. Also supports legacy `storage/session`, `message` and `part` JSON files. |

The adapters stay inside the selected account/history store. They follow saved relationships and explicit tool references; sharing a project folder is not enough to include an unrelated chat. Missing intermediate transcripts do not prevent recovery of descendants whose relationships can still be established.

## Bundle contents

- `RECOVER.md`: inventory and instructions for the destination coordinator.
- `manifest.json`: source platform, worker IDs, parent/child relationships, assignments, status evidence and capture warnings.
- `agent-<hash>.md`: original assignment, latest saved assistant text and observed file/tool references.
- `agent-<hash>.jsonl`: normalized saved messages and tool activity, excluding hidden reasoning and provider metadata.
- `coordinator.jsonl` for Codex, Gemini and OpenCode: normalized parent context. Prefer this over stale records in the upstream parser archive: it applies Gemini journal changes and includes newer OpenCode message records.

Each task has a **historical** status such as `reported_finished`, `blocked_quota`, `reported_failed` or `unknown`. `liveState` remains `not_checked`. Background dispatch success is not worker completion, and a completed turn is not proof the entire assignment passed validation.

The destination should check the current goal, verify existing outputs, reconcile parent/child scopes, and resume only unfinished work. A worker's earlier completed task may no longer be relevant. Missing transcripts are retained as assignment-only records when the dispatch can be recovered. Nothing is blindly replayed.

## Limits

This restores saved context, not processes, in-memory execution state, credentials, permissions or tool connections. Deleted, cloud-only or unrecorded workers cannot be reconstructed. A custom tool with no saved delegation identity may not be distinguishable from an ordinary tool. Source versions can change their storage formats; warnings should be reviewed before relying on a bundle.

Read/write file tools provide explicit file references. Paths mentioned only inside shell commands or prose remain in the transcript; the inventory is not an exhaustive filesystem change log. Original project outputs are inspected for existence, not copied or modified by recovery.

For a Codex full-history fork, filtering depends on the ancestor records still being available. Unverifiable inherited context should be reviewed against the coordinator before assigning new work. Capture warnings flag damaged or missing records, and file-backed snapshots are checked for changes during capture.

## Verification and format references

Tests use fictional nested histories for all four sources and exercise every cross-agent destination, missing transcripts, quota failures, inherited Codex history, Gemini journal edits and rewinds, OpenCode background tasks, and SQLite WAL reads. This validates recovery files and launch wiring; it does not claim a live model recovery run on every provider/version.

The additional adapters were checked against these upstream format definitions:

- [Codex session metadata and collaboration events](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/protocol/src/protocol.rs).
- [Gemini recording types](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/services/chatRecordingTypes.ts) and [journal storage](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/services/chatRecordingService.ts), also checked against installed Gemini 0.66.0.
- [OpenCode 1.19.5 task tool](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/tool/task.ts), [SQLite schema](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/session/sql.ts), and [newer message format](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/schema/src/session-message.ts).
