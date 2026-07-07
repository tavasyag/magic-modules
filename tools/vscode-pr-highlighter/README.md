# PR Highlighter

Highlights lines in the editor by the GitHub PR that introduced them, with intensity based on how recently the PR was merged.

## Usage

Open any file in a GitHub repo and press **Cmd+Alt+H** (Mac) / **Ctrl+Alt+H** (Windows/Linux), or run **PR Highlighter: Toggle PR Highlights** from the Command Palette.

- Press again to clear the highlights
- Hover over any highlighted line to see the PR title, author, and merge date
- Click the CodeLens label above a PR block to open it on GitHub

## Auth

The extension uses the `gh` CLI token automatically if you're authenticated:

```bash
gh auth login
```

Alternatively, set a GitHub personal access token (with `repo` scope) in VS Code Settings under `prHighlighter.githubToken`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `prHighlighter.githubToken` | `""` | GitHub PAT (optional if `gh` CLI is authenticated) |
| `prHighlighter.enableCodeLens` | `true` | Show/hide CodeLens PR labels |

## Installation

Install from the `.vsix` file: VS Code Command Palette → **Extensions: Install from VSIX...**
