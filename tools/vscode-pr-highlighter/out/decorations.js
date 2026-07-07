"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearEditorHighlights = clearEditorHighlights;
exports.clearAllHighlights = clearAllHighlights;
exports.clearStaleHighlights = clearStaleHighlights;
exports.reapplyAllHighlights = reapplyAllHighlights;
exports.toggleHighlights = toggleHighlights;
exports.applyHighlights = applyHighlights;
const vscode = __importStar(require("vscode"));
const blame_1 = require("./blame");
const github_1 = require("./github");
const hover_1 = require("./hover");
// Keyed by editor.document.uri.toString()
const activeEditors = new Map();
// Returns a 0–1 intensity value: 1.0 = merged today, decays exponentially over ~2 years.
function recencyIntensity(mergedAt) {
    if (!mergedAt)
        return 0.5;
    const ageDays = (Date.now() - new Date(mergedAt).getTime()) / 86400000;
    // Half-life of ~180 days: recent PRs are vivid, 1-year-old PRs ~25%, 2-year ~6%
    return Math.exp(-ageDays / 260);
}
function prColors(prNumber, isDark, mergedAt) {
    const hue = (prNumber * 137) % 360;
    const intensity = recencyIntensity(mergedAt);
    const borderLightness = isDark ? 55 : 45;
    const bgLightness = isDark ? 30 : 70;
    const borderAlpha = 0.4 + intensity * 0.6; // 0.4 → 1.0
    const bgAlpha = 0.06 + intensity * 0.19; // 0.06 → 0.25
    return {
        border: `hsla(${hue}, 70%, ${borderLightness}%, ${borderAlpha.toFixed(2)})`,
        bg: `hsla(${hue}, 60%, ${bgLightness}%, ${bgAlpha.toFixed(2)})`,
    };
}
function isDarkTheme() {
    const kind = vscode.window.activeColorTheme.kind;
    return (kind === vscode.ColorThemeKind.Dark ||
        kind === vscode.ColorThemeKind.HighContrast);
}
function applyDecorationForPr(editor, pr, lines, state) {
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
function clearEditorHighlights(key) {
    const state = activeEditors.get(key);
    if (!state)
        return;
    for (const dt of state.decorationTypes)
        dt.dispose();
    state.hoverDisposable.dispose();
    state.codeLensDisposable.dispose();
    state.changeDisposable.dispose();
    activeEditors.delete(key);
}
function clearAllHighlights() {
    for (const key of activeEditors.keys())
        clearEditorHighlights(key);
}
function clearStaleHighlights(visibleUris) {
    for (const key of activeEditors.keys()) {
        if (!visibleUris.has(key))
            clearEditorHighlights(key);
    }
}
async function reapplyAllHighlights() {
    // Collect editors to reapply (clear first, then re-trigger)
    const editors = [];
    for (const key of activeEditors.keys()) {
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
        if (editor)
            editors.push(editor);
    }
    for (const editor of editors) {
        clearEditorHighlights(editor.document.uri.toString());
        await applyHighlights(editor);
    }
}
async function toggleHighlights(editor) {
    const key = editor.document.uri.toString();
    if (activeEditors.has(key)) {
        clearEditorHighlights(key);
        return;
    }
    await applyHighlights(editor);
}
async function applyHighlights(editor) {
    const filePath = editor.document.uri.fsPath;
    const repoRoot = await (0, blame_1.findRepoRoot)(filePath);
    if (!repoRoot) {
        vscode.window.showInformationMessage('PR Highlighter: Not in a git repository.');
        return;
    }
    const lineToSha = await (0, blame_1.getBlameData)(filePath, repoRoot);
    if (!lineToSha) {
        vscode.window.showInformationMessage('PR Highlighter: File has no git history (untracked or new file).');
        return;
    }
    const ownerRepo = await (0, github_1.detectOwnerRepo)(repoRoot);
    if (!ownerRepo) {
        vscode.window.showWarningMessage('PR Highlighter: Could not detect GitHub owner/repo from remote URL.');
        return;
    }
    // Group lines by SHA
    const shaToLines = new Map();
    for (const [line, sha] of lineToSha) {
        const existing = shaToLines.get(sha);
        if (existing)
            existing.push(line);
        else
            shaToLines.set(sha, [line]);
    }
    const uniqueShas = [...shaToLines.keys()];
    const shaToPr = new Map();
    // Register state early so the change listener can clean up even during loading
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === editor.document) {
            clearEditorHighlights(editor.document.uri.toString());
        }
    });
    const state = {
        decorationTypes: [],
        lineToSha,
        shaToPr,
        hoverDisposable: (0, hover_1.registerHoverProvider)(editor.document, lineToSha, shaToPr),
        codeLensDisposable: { dispose: () => { } }, // placeholder, replaced below
        changeDisposable,
    };
    activeEditors.set(editor.document.uri.toString(), state);
    // Fetch PRs concurrently with a limit; apply decorations as each resolves
    const token = await (async () => null)(); // just to check if authed — github.ts handles internally
    const concurrencyLimit = 5;
    const tasks = uniqueShas.map((sha) => async () => {
        const pr = await (0, github_1.fetchPrForCommit)(ownerRepo, sha);
        if (!pr)
            return;
        // Guard: editor may have been closed or highlights cleared during async work
        if (!activeEditors.has(editor.document.uri.toString()))
            return;
        const lines = shaToLines.get(sha);
        applyDecorationForPr(editor, pr, lines, state);
    });
    await (0, github_1.withConcurrencyLimit)(tasks, concurrencyLimit);
    // Compute first line per PR for CodeLens
    const prToFirstLine = new Map();
    for (const [sha, lines] of shaToLines) {
        const pr = shaToPr.get(sha);
        if (!pr)
            continue;
        const minLine = Math.min(...lines);
        const existing = prToFirstLine.get(pr.number);
        if (existing === undefined || minLine < existing) {
            prToFirstLine.set(pr.number, minLine);
        }
    }
    // Replace placeholder CodeLens disposable if state still active
    const current = activeEditors.get(editor.document.uri.toString());
    if (current) {
        current.codeLensDisposable = (0, hover_1.registerCodeLensProvider)(editor.document, prToFirstLine, shaToPr);
    }
}
//# sourceMappingURL=decorations.js.map