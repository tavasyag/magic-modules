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
exports.runCommand = runCommand;
exports.parsePorcelain = parsePorcelain;
exports.findRepoRoot = findRepoRoot;
exports.getBlameData = getBlameData;
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
function runCommand(cmd, args, cwd) {
    return new Promise((resolve) => {
        const proc = cp.spawn(cmd, args, { cwd });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        proc.on('error', () => resolve({ stdout, stderr, exitCode: 1 }));
    });
}
// Parses `git blame --porcelain` output into a Map<1-based-line-number, sha>.
// Uncommitted lines (zero SHA) are excluded.
function parsePorcelain(raw) {
    const lineToSha = new Map();
    const ZERO_SHA = '0'.repeat(40);
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
        const headerMatch = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)/);
        if (headerMatch) {
            const sha = headerMatch[1];
            const finalLine = parseInt(headerMatch[2], 10);
            if (sha !== ZERO_SHA) {
                lineToSha.set(finalLine, sha);
            }
            i++;
            // Skip metadata lines until the tab-prefixed content line
            while (i < lines.length && !lines[i].startsWith('\t')) {
                i++;
            }
            i++; // skip the content line
        }
        else {
            i++;
        }
    }
    return lineToSha;
}
async function findRepoRoot(filePath) {
    const dir = path.dirname(filePath);
    const result = await runCommand('git', ['rev-parse', '--show-toplevel'], dir);
    if (result.exitCode !== 0)
        return null;
    return result.stdout.trim();
}
// Returns null if the file has no git history (untracked, new, or binary).
async function getBlameData(filePath, repoRoot) {
    const result = await runCommand('git', ['blame', '--porcelain', filePath], repoRoot);
    if (result.exitCode !== 0)
        return null;
    if (!result.stdout.trim())
        return null;
    return parsePorcelain(result.stdout);
}
//# sourceMappingURL=blame.js.map