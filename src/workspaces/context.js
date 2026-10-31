import { quote } from 'shell-quote';

export class WorkspaceContextError extends Error {
  constructor(message, workspace) {
    super(message);
    this.name = 'WorkspaceContextError';
    this.code = 'WORKSPACE_CONTEXT';
    this.workspace = workspace;
  }
}
export const clean = (value) => String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function contextInstructions(workspace) {
  if (workspace.kind === 'git') {
    const lines = [
      `Required repository: ${clean(workspace.identity || '(no remote recorded)')}`,
      `Required base commit: ${workspace.base}`,
    ];
    if (workspace.cloneUrl)
      lines.push(
        `Check out the repository:\n  git clone ${/^[A-Za-z0-9_./:@-]+$/.test(workspace.cloneUrl) ? workspace.cloneUrl : quote([workspace.cloneUrl])}`,
        'If the repository is private, ask its owner or organization administrator for access using your own Git account.',
      );
    else lines.push('Ask the sender for the repository URL or a checkout containing this commit.');
    lines.push(
      'In an existing checkout, fetch its trusted remote to obtain the base commit, then run resume again there (or use --cwd PATH).',
    );
    return lines.join('\n');
  }
  if (workspace.kind === 'gdrive')
    return [
      `Required Google Drive folder: ${clean(workspace.name)}`,
      `Folder link: https://drive.google.com/drive/folders/${workspace.folderId}`,
      'Open that link using your own Google account. If access is denied, choose Request access, or ask the owner/shared-drive manager to share this folder with your account. Ask for Editor access if the job requires modifying files.',
      'After access is granted, make the folder available locally through Drive for desktop. Run resume from that folder (or use --cwd PATH). Wait for Drive to finish syncing.',
      'Sharing a session does not grant Google Drive permissions. No access request is sent automatically.',
    ].join('\n');
  return `Original local folder: ${clean(workspace.name)}\nIts files are not included. Ask the sender for the inputs required for this job. Automatic file collection for ordinary folders is not implemented yet.`;
}
