# Contributing

Use Node.js 22.17+; Node 24 is also tested.

```sh
npm ci --ignore-scripts
npm run format       # Apply the pinned formatter before committing
npm run check        # Formatting and syntax
npm test
npm run test:package
```

Tests use isolated fictional histories and stub targets. They do not need model credentials. The package installation check exercises the real global executable, including Windows npm shims.

Keep behavior changes covered at the boundary: session discovery, directory matching, target arguments, account environment isolation or saved recovery artifacts. Never commit real chats, generated `.resume/` directories, credentials or account configuration. Screenshots must use the [fictional demo](docs/screenshots.md).

For bug reports, include your operating system, Node version, target CLI version, the command, and a sanitized error. Do not attach full conversation archives or authentication files. Mention whether the target is a shell alias and whether the source uses a custom history root.

## Releases

1. Update `package.json`, `package-lock.json`, the changelog and release links in the README.
2. Run the checks above and inspect `npm pack --dry-run --json`. Only `bin/`, `src/`, `README.md`, `LICENSE` and `package.json` belong in the package.
3. Push the release commit and wait for the six OS/Node matrix jobs to pass.
4. Create the matching `vX.Y.Z` tag and build the tarball with `npm pack` from that commit.
5. Publish the exact tarball with `npm publish ./pranciskusj-resume-session-X.Y.Z.tgz --access public`, completing npm's required authentication.
6. Publish a GitHub release with the same tarball and its SHA-256 checksum. Verify an anonymous fresh-prefix installation from npm and the release URL.

Never publish an untested working tree or change an already published version. npm publishing credentials are not stored in this repository.

The cloud service and server integration tests live in the private `resume-infra` repository. This repository contains the CLI, workspace adapters, cloud client and public protocol contract only.
