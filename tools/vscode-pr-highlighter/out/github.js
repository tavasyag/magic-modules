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
exports.clearTokenCache = clearTokenCache;
exports.clearPrCache = clearPrCache;
exports.parseOwnerRepo = parseOwnerRepo;
exports.detectOwnerRepo = detectOwnerRepo;
exports.fetchPrForCommit = fetchPrForCommit;
exports.withConcurrencyLimit = withConcurrencyLimit;
const vscode = __importStar(require("vscode"));
const blame_1 = require("./blame");
// Module-level cache: undefined = not resolved yet, null = no token available
let cachedToken = undefined;
// Module-level PR cache keyed by "owner/repo:sha"
const prCache = new Map();
function clearTokenCache() {
    cachedToken = undefined;
}
function clearPrCache() {
    prCache.clear();
}
async function resolveToken() {
    if (cachedToken !== undefined)
        return cachedToken;
    const config = vscode.workspace.getConfiguration('prHighlighter');
    const settingToken = config.get('githubToken', '').trim();
    if (settingToken) {
        cachedToken = settingToken;
        return cachedToken;
    }
    try {
        const result = await (0, blame_1.runCommand)('gh', ['auth', 'token'], process.cwd());
        if (result.exitCode === 0 && result.stdout.trim()) {
            cachedToken = result.stdout.trim();
            return cachedToken;
        }
    }
    catch {
        // gh not installed or not authenticated
    }
    cachedToken = null;
    return null;
}
function parseOwnerRepo(remoteUrl) {
    const url = remoteUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');
    // HTTPS: https://github.com/owner/repo
    const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
    if (httpsMatch)
        return { owner: httpsMatch[1], repo: httpsMatch[2] };
    // SSH: git@github.com:owner/repo
    const sshMatch = url.match(/git@[^:]+:([^/]+)\/(.+)$/);
    if (sshMatch)
        return { owner: sshMatch[1], repo: sshMatch[2] };
    // SSH URI: ssh://git@github.com/owner/repo
    const sshUriMatch = url.match(/ssh:\/\/[^/]+\/([^/]+)\/(.+)$/);
    if (sshUriMatch)
        return { owner: sshUriMatch[1], repo: sshUriMatch[2] };
    return null;
}
async function detectOwnerRepo(repoRoot) {
    for (const remote of ['origin', 'upstream']) {
        const result = await (0, blame_1.runCommand)('git', ['remote', 'get-url', remote], repoRoot);
        if (result.exitCode === 0) {
            const parsed = parseOwnerRepo(result.stdout.trim());
            if (parsed)
                return parsed;
        }
    }
    // Fall back to listing all remotes
    const listResult = await (0, blame_1.runCommand)('git', ['remote'], repoRoot);
    if (listResult.exitCode !== 0)
        return null;
    for (const remote of listResult.stdout.trim().split('\n')) {
        const r = remote.trim();
        if (!r)
            continue;
        const result = await (0, blame_1.runCommand)('git', ['remote', 'get-url', r], repoRoot);
        if (result.exitCode === 0) {
            const parsed = parseOwnerRepo(result.stdout.trim());
            if (parsed)
                return parsed;
        }
    }
    return null;
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function githubFetch(url, token, retries = 2) {
    const headers = {
        Accept: 'application/vnd.github.groot-preview+json',
        'User-Agent': 'vscode-pr-highlighter',
    };
    if (token)
        headers['Authorization'] = `token ${token}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url, { headers });
        if (res.status === 403 || res.status === 429) {
            const resetHeader = res.headers.get('X-RateLimit-Reset');
            const waitMs = resetHeader
                ? Math.max(0, parseInt(resetHeader) * 1000 - Date.now()) + 1000
                : Math.min(1000 * Math.pow(2, attempt), 30000);
            if (attempt < retries) {
                await sleep(waitMs);
                continue;
            }
            return null;
        }
        if (res.status === 401) {
            cachedToken = undefined; // force re-resolution next call
            return null;
        }
        if (!res.ok)
            return null;
        return res.json();
    }
    return null;
}
async function fetchPrForCommit(ownerRepo, sha) {
    const cacheKey = `${ownerRepo.owner}/${ownerRepo.repo}:${sha}`;
    if (prCache.has(cacheKey))
        return prCache.get(cacheKey);
    const token = await resolveToken();
    const url = `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${sha}/pulls`;
    const data = await githubFetch(url, token);
    if (!data || !Array.isArray(data) || data.length === 0) {
        prCache.set(cacheKey, null);
        return null;
    }
    const pr = data[0];
    const info = {
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? 'unknown',
        mergedAt: pr.merged_at ?? '',
        url: pr.html_url,
        sha,
    };
    prCache.set(cacheKey, info);
    return info;
}
// Run at most `limit` async tasks concurrently.
async function withConcurrencyLimit(tasks, limit) {
    const results = new Array(tasks.length);
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            try {
                results[i] = { status: 'fulfilled', value: await tasks[i]() };
            }
            catch (e) {
                results[i] = { status: 'rejected', reason: e };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}
//# sourceMappingURL=github.js.map