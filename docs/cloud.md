# Sharing sessions

The CLI prepares portable checkpoints locally. The cloud service is maintained separately in the private `resume-infra` repository; this public repository does not include a server deployment.

Sharing commands are available in the current source checkout. The published npm version is unchanged until a new release is made.

## Connect

Obtain the service URL and team access token from your administrator. Set `RESUME_SERVER` to the HTTPS origin and `RESUME_TOKEN` in your terminal environment. Keep the token out of shell history and source control. Remote HTTP and redirects are rejected. Loopback HTTP is supported for local development.

```sh
resume share
resume rs_ID codex
resume rs_ID                  # Choose an installed agent or alias
resume rs_ID --history-only   # Continue without the original files
resume share --revoke rs_ID
```

Replace `rs_ID` with the complete ID printed by `resume share`. For automation, use `resume share --session LOCAL_ID --yes --json` and `resume rs_ID codex --prepare --json`. `--yes` approves uploading the displayed checkpoint. Diagnostics and progress use stderr; JSON results use stdout.

## Transfer and access limits

- Git changes are restored in a new detached worktree; the recipient needs the matching repository and base commit. No fetch, installation, hooks or tool-call replay is performed automatically.
- Git files include final tracked changes and non-ignored new files. Staging and unpushed commit boundaries are flattened. Changed symlinks and submodules are rejected.
- Drive workspaces reference existing shared files and retain Google permissions. Ordinary folders currently transfer history only.
- Capture includes saved conversation and worker records, not running processes, credentials, ignored files, external scratch files or provider permissions. It is not a lossless native session conversion.
- Both compressed and expanded payloads are limited to 32 MiB. Pause edits for a consistent capture; changing files are rejected.
- Review before sharing. Basic secret detection is not a guarantee. The current service uses a shared team token: holders can retrieve or revoke known IDs. Storage is not end-to-end encrypted. Revocation cannot recall downloaded copies.
- Expiry is reported in the upload receipt. The administrator controls retention and storage capacity.

See the [public API contract](protocol.md) and [checkpoint format](job-format.md). Server operators should use the deployment and operations documentation in `resume-infra`.

## Workspace matching and access help

Shared sessions can contain any kind of work: research, writing, analysis, planning, or development. Generated continuation prompts are task-neutral.

Before launching an agent, `resume rs_ID` checks the workspace:

| Source | Matching rule | If the recipient lacks the workspace |
| --- | --- | --- |
| Git | A matching remote identity and the required base commit | Shows the repository, clone URL when available, base commit, and private-repository access guidance |
| Google Drive | The same stable Drive folder ID, even if local folder names differ | Shows the exact folder link, how to request access, and how to make it available locally |
| Ordinary local folder | No automatic identity/file reconstruction yet | Explains that files were not bundled and offers history-only continuation |

A mismatch never silently resumes in an unrelated folder. The interactive choices are: continue with session history only, choose the correct local folder, or stop and set up access. Scripts receive the same instructions and can explicitly choose:

```sh
resume rs_ID codex --history-only
resume rs_ID clauded --history-only
```

History-only mode creates a private, separate workspace containing the conversation and saved worker context. It does **not** restore source file changes, use the unrelated current project, or imply that historical results have been verified. Repository/Drive access instructions remain in the handoff so the user can reconnect later. `RESUME_STATE_DIR` can override the private state directory (default: `~/.local/share/resume/sessions`).

### Google Drive

Google Drive workspaces reference existing shared files; they do not upload those files to the session server or alter Drive sharing permissions. The recipient works in their own locally available copy of the same Drive folder. Conversation archives are stored outside the Drive folder, so merely resuming does not sync private session history to collaborators.

Detection first uses native Drive desktop metadata where available. On supported DriveFS mirror schemas, it verifies folder inode ancestry against the account's recorded root, then retrieves the stable cloud folder ID using read-only database connections. It does not match folders by name or assume that all folders called “Project” are the same.

Desktop metadata formats vary. If the folder cannot be identified automatically, explicitly link the local folder once:

```sh
cd ~/path/to/shared-folder
resume drive link https://drive.google.com/drive/folders/FOLDER_ID
```

Use the folder link from Google Drive's Share dialog. This binding is stored locally and is identified as user-confirmed, rather than desktop-verified. It does not authenticate a Google account or prove online permissions. Conflicting native metadata cannot be overridden by a binding.

To obtain access, open the shared folder link with your own Google account and use **Request access**, or contact the owner/shared-drive manager. Request Editor access if the work requires changing files. Wait for Drive for desktop to sync before continuing. Folder access does not necessarily grant access to every restricted descendant. No request or invitation is sent automatically. [Google's access guidance](https://support.google.com/drive/answer/16722399?hl=en).

Drive contents are live, not frozen to the sharing time. Local cached availability does not guarantee current online access, edit permissions, or completed sync. The continuation brief explicitly asks the agent to inspect the current inputs.

### Ordinary folders and repeated handoffs

Ordinary folders can currently share session history and worker records, but their files are not bundled. Automatic collection of referenced inputs and outputs is a future workspace adapter. The preview makes this omission explicit.

Repeated handoffs preserve earlier shared conversations and worker packets separately from the latest session. An agent that immediately hits a usage limit can re-share the earlier job without having read or summarized it first. Up to 32 earlier shared contexts are retained, within the overall 32 MiB expanded-job limit.
