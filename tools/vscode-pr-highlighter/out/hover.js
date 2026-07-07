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
exports.registerHoverProvider = registerHoverProvider;
exports.registerCodeLensProvider = registerCodeLensProvider;
const vscode = __importStar(require("vscode"));
function registerHoverProvider(document, lineToSha, shaToPr) {
    return vscode.languages.registerHoverProvider({ pattern: document.uri.fsPath }, {
        provideHover(doc, position) {
            if (doc !== document)
                return null;
            // position.line is 0-based; blame uses 1-based
            const sha = lineToSha.get(position.line + 1);
            if (!sha)
                return null;
            const pr = shaToPr.get(sha);
            if (!pr)
                return null;
            const mergedDate = pr.mergedAt
                ? new Date(pr.mergedAt).toLocaleDateString()
                : 'unknown date';
            const addToChatCmd = vscode.Uri.parse(`command:prHighlighter.addToChat?${encodeURIComponent(JSON.stringify(pr.url))}`);
            const md = new vscode.MarkdownString(`**[#${pr.number} ${pr.title}](${pr.url})**\n\n` +
                `Author: \`${pr.author}\`  |  Merged: ${mergedDate}\n\n` +
                `[Open PR on GitHub](${pr.url})  |  [Add to Copilot Chat](${addToChatCmd})`);
            md.isTrusted = true;
            return new vscode.Hover(md);
        },
    });
}
function registerCodeLensProvider(document, prToFirstLine, shaToPr) {
    // Build a reverse map: prNumber → PrInfo
    const prInfoByNumber = new Map();
    for (const pr of shaToPr.values()) {
        prInfoByNumber.set(pr.number, pr);
    }
    const config = vscode.workspace.getConfiguration('prHighlighter');
    if (!config.get('enableCodeLens', true)) {
        return { dispose: () => { } };
    }
    return vscode.languages.registerCodeLensProvider({ pattern: document.uri.fsPath }, {
        provideCodeLenses(doc) {
            if (doc !== document)
                return [];
            const lenses = [];
            for (const [prNumber, firstLine] of prToFirstLine) {
                const pr = prInfoByNumber.get(prNumber);
                if (!pr)
                    continue;
                // firstLine is 1-based; CodeLens range is 0-based
                const range = new vscode.Range(firstLine - 1, 0, firstLine - 1, 0);
                lenses.push(new vscode.CodeLens(range, {
                    title: `#${pr.number} · ${pr.title} · @${pr.author}`,
                    command: 'vscode.open',
                    arguments: [vscode.Uri.parse(pr.url)],
                }));
            }
            return lenses;
        },
    });
}
//# sourceMappingURL=hover.js.map