import * as vscode from 'vscode';
import {
  toggleHighlights,
  clearAllHighlights,
  clearStaleHighlights,
  reapplyAllHighlights,
} from './decorations';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('prHighlighter.toggle', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await toggleHighlights(editor);
    }),

    vscode.commands.registerCommand('prHighlighter.addToChat', (prUrl: string) => {
      vscode.commands.executeCommand('workbench.action.chat.open', { query: prUrl, isPartialQuery: true });
    }),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      const visibleUris = new Set(editors.map((e) => e.document.uri.toString()));
      clearStaleHighlights(visibleUris);
    }),

    vscode.window.onDidChangeActiveColorTheme(async () => {
      await reapplyAllHighlights();
    }),

    { dispose: clearAllHighlights }
  );
}

export function deactivate(): void {}
