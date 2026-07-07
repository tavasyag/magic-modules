import * as vscode from 'vscode';
import { PrInfo } from './github';

export function registerHoverProvider(
  document: vscode.TextDocument,
  lineToSha: Map<number, string>,
  shaToPr: Map<string, PrInfo>
): vscode.Disposable {
  return vscode.languages.registerHoverProvider(
    { pattern: document.uri.fsPath },
    {
      provideHover(doc, position) {
        if (doc !== document) return null;

        // position.line is 0-based; blame uses 1-based
        const sha = lineToSha.get(position.line + 1);
        if (!sha) return null;

        const pr = shaToPr.get(sha);
        if (!pr) return null;

        const mergedDate = pr.mergedAt
          ? new Date(pr.mergedAt).toLocaleDateString()
          : 'unknown date';

        const addToChatCmd = vscode.Uri.parse(
          `command:prHighlighter.addToChat?${encodeURIComponent(JSON.stringify(pr.url))}`
        );
        const md = new vscode.MarkdownString(
          `**[#${pr.number} ${pr.title}](${pr.url})**\n\n` +
            `Author: \`${pr.author}\`  |  Merged: ${mergedDate}\n\n` +
            `[Open PR on GitHub](${pr.url})  |  [Add to Copilot Chat](${addToChatCmd})`
        );
        md.isTrusted = true;

        return new vscode.Hover(md);
      },
    }
  );
}

export function registerCodeLensProvider(
  document: vscode.TextDocument,
  prToFirstLine: Map<number, number>,
  shaToPr: Map<string, PrInfo>
): vscode.Disposable {
  // Build a reverse map: prNumber → PrInfo
  const prInfoByNumber = new Map<number, PrInfo>();
  for (const pr of shaToPr.values()) {
    prInfoByNumber.set(pr.number, pr);
  }

  const config = vscode.workspace.getConfiguration('prHighlighter');
  if (!config.get<boolean>('enableCodeLens', true)) {
    return { dispose: () => {} };
  }

  return vscode.languages.registerCodeLensProvider(
    { pattern: document.uri.fsPath },
    {
      provideCodeLenses(doc) {
        if (doc !== document) return [];

        const lenses: vscode.CodeLens[] = [];
        for (const [prNumber, firstLine] of prToFirstLine) {
          const pr = prInfoByNumber.get(prNumber);
          if (!pr) continue;

          // firstLine is 1-based; CodeLens range is 0-based
          const range = new vscode.Range(firstLine - 1, 0, firstLine - 1, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: `#${pr.number} · ${pr.title} · @${pr.author}`,
              command: 'vscode.open',
              arguments: [vscode.Uri.parse(pr.url)],
            })
          );
        }
        return lenses;
      },
    }
  );
}
