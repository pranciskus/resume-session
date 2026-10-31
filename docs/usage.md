# Usage reference

[Back to the README](../README.md)

## Folder filtering

```sh
cd ~/git/my-project
resume clauded                       # this project and its subfolders only
resume list                          # the same folder scope
resume codex --path ~/git/other       # explicitly choose another folder
resume claude --all                   # explicitly show all folders
resume codex --search authentication  # text filter within this folder
resume list --json                    # structured metadata, no chat bodies
```

Path matching respects directory boundaries: `my-project-old` is not included in `my-project`. Relative paths and quoted paths containing spaces work. Windows paths are matched case-insensitively. Existing symlink paths are resolved so alternate names for the same folder match. Missing paths fall back to lexical matching; use the recorded path with `--path` when a project has moved.

`--cwd NEW_PATH` changes the launch directory; it does not change the history filter. For a moved project use `--path OLD_PATH --cwd NEW_PATH`.

## Accounts and aliases

Log in with the desired account using your agent's normal login command, then run `resume TARGET`. `resume` does not manage credentials, change accounts, or copy authentication files. Histories shared by multiple logins are shown together; labels identify storage directories, not authenticated account identities.

For example, if account A and account B both used `~/.claude`, logging in as B does not hide A's saved chats: `resume claude` and `resume clauded` list both accounts' saved chats for the current folder. When accounts used separate history directories, their chats are combined once those directories are discovered or registered. The selected chat continues with the currently active target login, never with credentials copied from its source account.

Discovery includes default directories, current environment overrides, account roots in configured target environments, and sibling `~/.claude-*`, `~/.claude_*`, `~/.codex-*`, `~/.codex_*` account directories. Register other locations once:

```sh
resume source add claude-work --tool claude --root ~/.config/claude-work
resume source add codex-work --tool codex --root ~/.config/codex-work
resume source add gemini-work --tool gemini --root ~/gemini-work-home
resume source add opencode-work --tool opencode --root ~/work-data
```

Root meanings:

| Agent | Root contains | Default |
| --- | --- | --- |
| Claude | `projects/` | `~/.claude` |
| Codex | `sessions/`, `archived_sessions/` | `~/.codex` |
| Gemini | `.gemini/` | home directory |
| OpenCode | `opencode/` | `~/.local/share` |

Environment overrides are `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME`, and `OPENCODE_DB`.

Alias names are not hardcoded. Resume reads the alias definition from your interactive shell, detects the underlying agent, and invokes the original alias so its flags, quoting and environment assignments remain intact. Alias chains are supported. For example:

```sh
alias my-coding-helper='CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --chrome'
resume my-coding-helper --model sonnet
```

Save the alias in your shell startup file first, as described below. Complex functions or wrappers whose agent cannot be determined can be registered explicitly:

```sh
resume target add work-ai --tool claude
resume work-ai
```

On Unix, aliases/functions must be defined in the startup configuration of your interactive `$SHELL` (bash, zsh, fish). Definitions made only in the current terminal cannot be inherited by a child process. Bash/zsh aliases and fish aliases with `--wraps` metadata are detected automatically. On Windows, shell targets use PowerShell 7 (`pwsh`) and its profile; aliases and single-command functions can be detected automatically. Normal agent commands use direct executable launching, including npm `.cmd` shims. An alias named `claude` or `codex` also takes precedence over the bare executable.

Configuration lives in `~/.config/resume/config.json`, or the path in `RESUME_CONFIG`. Explicit command targets can avoid shell startup:

```json
{
  "targets": {
    "work-ai": {
      "tool": "claude",
      "command": "claude",
      "args": [],
      "env": { "CLAUDE_CONFIG_DIR": "/absolute/path/to/claude-work" },
      "shell": false
    }
  }
}
```

Configuration is validated before use. Saves replace the file atomically with private permissions; existing dotfiles symlinks are preserved. Repair a dangling config symlink before saving. Target names cannot use CLI commands (`list`, `source`, `target`, `share`, `drive`) or the `rs_` shared-session prefix.

Extra target flags pass through directly, for example `resume clauded --model sonnet`. Resume consumes its own options (`--session`, `--path`, `--search`, etc.); use `--` to send conflicting options to the agent, for example `resume clauded -- --help`. Arguments remain separate strings, so spaces and shell metacharacters are not reinterpreted. The handoff prompt is separated from positional Claude/Codex flags with `--`, preventing a variadic option from swallowing it. Aliases retain the options you defined for them; resume adds no permission-bypass flags itself.

## What transfers

When the source and target are the same agent using the same history root, resume uses that agent's native session ID. Cross-agent, cross-root and shell-alias launches start a new chat with a context file in the source project's `.resume/` folder. Files have unique names so simultaneous handoffs do not overwrite each other. History files are only read.

Each handoff includes two conversation files: a Markdown brief with recent conversation (up to 50 messages, 10,000 characters each), recorded tool activity, file changes, pending tasks and compacted summaries; and a `.history.json` archive containing every conversation message returned by the parser, without the brief's message-count or rendering limits. The launch prompt directs the agent to consult the archive for earlier requirements and decisions.

When a Claude, Codex, Gemini or OpenCode chat has recorded delegated work, the handoff also creates a `.agents/` recovery bundle: `RECOVER.md`, a machine-readable manifest, and per-worker assignment packets and normalized transcript snapshots. It recovers nested parent/child relationships, saved tool activity and file references, and evidence of completion or quota failures. Dispatches without saved worker transcripts remain visible with warnings. Historical completion is not proof that an output is valid or that a process is currently stopped.

The target is instructed to inspect existing outputs, reconcile the current goal and parent/child scopes, and recreate only unfinished workers using its own subagent tools (or work sequentially when unavailable). This does not migrate running agent processes, credentials, permissions, MCP connections or hidden state. It does not blindly replay old tool calls. Cancel an original session's automatic continuation before letting a replacement modify the same files.

Use `--prepare` to write and inspect the handoff and recovery bundle without launching the target. Normal cross-agent handoffs generate worker recovery automatically; same-agent native resumes retain their native behavior.

This is **context transfer, not lossless native history conversion**. Images, hidden state, permissions and every historical tool result are not recreated. Tool samples and compacted summaries retain the parser's limits. The original history path is included for deeper inspection. No extra model call or API key is needed to prepare the handoff.

The target starts in the selected chat's recorded project directory. A missing directory produces an error; use `--cwd` to relocate it. Local history must still exist and be readable; deleted or cloud-only histories cannot be recovered. The target CLI must be installed and logged in.

Handoffs contain private conversation text. They stay local until the selected agent reads them using its usual provider connection. Add `.resume/` to your project's ignore file if needed; remove that folder when the files are no longer useful. It is not automatically deleted because resumed chats may reference it later.

```sh
resume codex --session SESSION_ID --dry-run  # no handoff write or agent launch
resume claude --session SESSION_ID --handoff # force a new chat with context
resume codex --session SESSION_ID --prepare # save context and worker recovery without launching
```

Session IDs must match exactly. If the same ID exists in multiple roots, use the full `key` from `resume list --json`. The current-folder filter applies to explicit IDs too; use `--all` or `--path` intentionally.

See [subagent recovery formats and limits](recovery.md) for platform-specific storage support and the normalized coordinator archive.

## Install or update

```sh
npm install -g @pranciskusj/resume-session
```

To run without a global installation:

```sh
npx --yes --package=@pranciskusj/resume-session resume codex
```
