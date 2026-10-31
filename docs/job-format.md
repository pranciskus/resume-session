# Portable job format

The transfer unit is a versioned job envelope (`resume-handoff/1`), serialized as JSON and gzip-compressed. The storage service treats it as opaque bytes. It is not a Git bundle or a provider-native session file.

| Field | Responsibility |
| --- | --- |
| `session` | Agent source, session provenance, conversation brief and parsed messages |
| `recovery` | Saved worker records, relationships, recovery packets and warning counts |
| `workspace` | Adapter kind and reconstruction metadata; `git`, `gdrive`, or history-only `folder` |
| `files` | Relative file paths, base64 contents, executable bits and deletions |
| `resources` | Logical project root marker, capture scope and external-file inclusion policy |
| `ancestry` | Earlier shared contexts, retained even if the receiving agent immediately hits a limit |
| `createdAt`, `format` | Timestamp and compatibility version |

The common layer validates relative paths and file payloads, maps project paths, restores history, and builds a continuation prompt. Workspace adapters implement `capture`, `verify`, `validate`, `check`, and `restore`; restore returns the destination and a cleanup operation. The Git adapter alone chooses a base commit and manages worktrees. Unknown format or adapter versions fail before creating a workspace.

Validation also covers inherited contexts and embedded JSON/JSONL recovery packets before restoration begins. Each file or artifact list is limited to 10,000 entries, context ancestry to 32 sessions, JSON nesting to 128 levels, and the entire envelope to 32 MiB. Paths must be portable across supported systems; case-insensitive and Unicode-normalized duplicates, live file/directory conflicts, and reserved names are rejected. Explicit deletions can still replace files with directories or directories with files.

The project marker is `{{RESUME_PROJECT_ROOT}}`. It is mapped inside conversation and worker records; code-file bytes are preserved exactly. JSON worker records are mapped structurally to preserve escaping on Windows. Source paths are matched at boundaries so a workspace named `job` does not rewrite references to `job-backup`. Paths outside that project are not implicitly treated as transferable files.

## Extending to folders and whole jobs

The `folder` adapter currently carries history only. Future file collection can use the same server, IDs, compression, session parsing, worker recovery and launch logic. It should restore into a new directory rather than require a Git checkout. Drive reference matching and history-only imports work today; full file-bundle reconstruction for ordinary folders does not.

For a whole-job export, extend the resource inventory with logical roots and per-resource provenance:

- How a file was referenced: user attachment, tool read, generated output, or explicit selection.
- Original logical path and destination mapping.
- Whether current bytes were included, the resource was unavailable, or the user excluded it.
- Content hash, byte size, and capture timestamp; history may refer to a different revision of the file.

Use tool records to propose an inventory, then let the sender review it. A transcript is not a complete dependency graph: shell commands, directory reads, omitted tool results, databases, remote services and temporary files can hide dependencies. Never label a job self-contained merely because every detected filename was copied.

Whole-folder capture must respect exclusions, protect credentials, bound size and file count, and reject symlink traversal. External resources need explicit root mappings rather than flattening filenames or reproducing arbitrary absolute paths. A receiver should see missing inputs before launch. These additions belong in the workspace/resource adapters, not in the HTTP storage service.
