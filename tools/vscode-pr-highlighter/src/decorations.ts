import * as vscode from 'vscode';
import { getBlameData, findRepoRoot } from './blame';
import { detectOwnerRepo, fetchPrForCommit, withConcurrencyLimit, PrInfo } from './github';
import { registerHoverProvider, registerCodeLensProvider } from './hover';

interface EditorHighlightState {
  decorationTypes: vscode.TextEditorDecorationType[];
  lineToSha: Map<number, string>;
  shaToPr: Map<string, PrInfo>;
  hoverDisposable: vscode.Disposable;
  codeLensDisposable: vscode.Disposable;
  changeDisposable: vscode.Disposable;
}

// Keyed by editor.document.uri.toString()
const activeEditors = new Map<string, EditorHighlightState>();

// Returns a 0–1 intensity value: 1.0 = merged today, decays exponentially over ~2 years.
function recencyIntensity(mergedAt: string): number {
  if (!mergedAt) return 0.5;
  const ageDays = (Date.now() - new Date(mergedAt).getTime()) / 86_400_000;
  // Half-life of ~180 days: recent PRs are vivid, 1-year-old PRs ~25%, 2-year ~6%
  return Math.exp(-ageDays / 260);
}

function prColors(prNumber: number, isDark: boolean, mergedAt: string): { border: string; bg: string } {
  const hue = (prNumber * 137) % 360;
  const intensity = recencyIntensity(mergedAt);
  const borderLightness = isDark ? 55 : 45;
  const bgLightness = isDark ? 30 : 70;
  const borderAlpha = 0.4 + intensity * 0.6;   // 0.4 → 1.0
  const bgAlpha = 0.06 + intensity * 0.19;      // 0.06 → 0.25
  return {
    border: `hsla(${hue}, 70%, ${borderLightness}%, ${borderAlpha.toFixed(2)})`,
    bg: `hsla(${hue}, 60%, ${bgLightness}%, ${bgAlpha.toFixed(2)})`,
  };
}

function isDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return (
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast
  );
}

function applyDecorationForPr(
  editor: vscode.TextEditor,
  pr: PrInfo,
  lines: number[],
  state: EditorHighlightState
): void {
  const { border, bg } = prColors(pr.number, isDarkTheme(), pr.mergedAt);
  const decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: bg,
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: border,
    overviewRulerColor: border,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  // git blame uses 1-based lines; VS Code ranges are 0-based
  const ranges = lines.map((line) => new vscode.Range(line - 1, 0, line - 1, 0));
  editor.setDecorations(decorationType, ranges);
  state.decorationTypes.push(decorationType);
  state.shaToPr.set(pr.sha, pr);
}

export function clearEditorHighlights(key: string): void {
  const state = activeEditors.get(key);
  if (!state) return;
  for (const dt of state.decorationTypes) dt.dispose();
  state.hoverDisposable.dispose();
  state.codeLensDisposable.dispose();
  state.changeDisposable.dispose();
  activeEditors.delete(key);
}

export function clearAllHighlights(): void {
  for (const key of activeEditors.keys()) clearEditorHighlights(key);
}

export function clearStaleHighlights(visibleUris: Set<string>): void {
  for (const key of activeEditors.keys()) {
    if (!visibleUris.has(key)) clearEditorHighlights(key);
  }
}

export async function reapplyAllHighlights(): Promise<void> {
  // Collect editors to reapply (clear first, then re-trigger)
  const editors: vscode.TextEditor[] = [];
  for (const key of activeEditors.keys()) {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === key
    );
    if (editor) editors.push(editor);
  }
  for (const editor of editors) {
    clearEditorHighlights(editor.document.uri.toString());
    await applyHighlights(editor);
  }
}

export async function toggleHighlights(editor: vscode.TextEditor): Promise<void> {
  const key = editor.document.uri.toString();
  if (activeEditors.has(key)) {
    clearEditorHighlights(key);
    return;
  }
  await applyHighlights(editor);
}

export async function applyHighlights(editor: vscode.TextEditor): Promise<void> {
  const filePath = editor.document.uri.fsPath;

  const repoRoot = await findRepoRoot(filePath);
  if (!repoRoot) {
    vscode.window.showInformationMessage('PR Highlighter: Not in a git repository.');
    return;
  }

  const lineToSha = await getBlameData(filePath, repoRoot);
  if (!lineToSha) {
    vscode.window.showInformationMessage(
      'PR Highlighter: File has no git history (untracked or new file).'
    );
    return;
  }

  const ownerRepo = await detectOwnerRepo(repoRoot);
  if (!ownerRepo) {
    vscode.window.showWarningMessage(
      'PR Highlighter: Could not detect GitHub owner/repo from remote URL.'
    );
    return;
  }

  // Group lines by SHA
  const shaToLines = new Map<string, number[]>();
  for (const [line, sha] of lineToSha) {
    const existing = shaToLines.get(sha);
    if (existing) existing.push(line);
    else shaToLines.set(sha, [line]);
  }

  const uniqueShas = [...shaToLines.keys()];
  const shaToPr = new Map<string, PrInfo>();

  // Register state early so the change listener can clean up even during loading
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document === editor.document) {
      clearEditorHighlights(editor.document.uri.toString());
    }
  });

  const state: EditorHighlightState = {
    decorationTypes: [],
    lineToSha,
    shaToPr,
    hoverDisposable: registerHoverProvider(editor.document, lineToSha, shaToPr),
    codeLensDisposable: { dispose: () => {} }, // placeholder, replaced below
    changeDisposable,
  };
  activeEditors.set(editor.document.uri.toString(), state);

  // Fetch PRs concurrently with a limit; apply decorations as each resolves
  const token = await (async () => null)(); // just to check if authed — github.ts handles internally
  const concurrencyLimit = 5;

  const tasks = uniqueShas.map((sha) => async () => {
    const pr = await fetchPrForCommit(ownerRepo, sha);
    if (!pr) return;
    // Guard: editor may have been closed or highlights cleared during async work
    if (!activeEditors.has(editor.document.uri.toString())) return;
    const lines = shaToLines.get(sha)!;
    applyDecorationForPr(editor, pr, lines, state);
  });

  await withConcurrencyLimit(tasks, concurrencyLimit);

  // Compute first line per PR for CodeLens
  const prToFirstLine = new Map<number, number>();
  for (const [sha, lines] of shaToLines) {
    const pr = shaToPr.get(sha);
    if (!pr) continue;
    const minLine = Math.min(...lines);
    const existing = prToFirstLine.get(pr.number);
    if (existing === undefined || minLine < existing) {
      prToFirstLine.set(pr.number, minLine);
    }
  }

  // Replace placeholder CodeLens disposable if state still active
  const current = activeEditors.get(editor.document.uri.toString());
  if (current) {
    current.codeLensDisposable = registerCodeLensProvider(
      editor.document,
      prToFirstLine,
      shaToPr
    );
  }
}
