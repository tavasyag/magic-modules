import * as vscode from 'vscode';
import { runCommand } from './blame';

export interface PrInfo {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  sha: string;
}

// Module-level cache: undefined = not resolved yet, null = no token available
let cachedToken: string | null | undefined = undefined;

// Module-level PR cache keyed by "owner/repo:sha"
const prCache = new Map<string, PrInfo | null>();

export function clearTokenCache(): void {
  cachedToken = undefined;
}

export function clearPrCache(): void {
  prCache.clear();
}

async function resolveToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;

  const config = vscode.workspace.getConfiguration('prHighlighter');
  const settingToken = config.get<string>('githubToken', '').trim();
  if (settingToken) {
    cachedToken = settingToken;
    return cachedToken;
  }

  try {
    const result = await runCommand('gh', ['auth', 'token'], process.cwd());
    if (result.exitCode === 0 && result.stdout.trim()) {
      cachedToken = result.stdout.trim();
      return cachedToken;
    }
  } catch {
    // gh not installed or not authenticated
  }

  cachedToken = null;
  return null;
}

export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const url = remoteUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');

  // HTTPS: https://github.com/owner/repo
  const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  // SSH: git@github.com:owner/repo
  const sshMatch = url.match(/git@[^:]+:([^/]+)\/(.+)$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // SSH URI: ssh://git@github.com/owner/repo
  const sshUriMatch = url.match(/ssh:\/\/[^/]+\/([^/]+)\/(.+)$/);
  if (sshUriMatch) return { owner: sshUriMatch[1], repo: sshUriMatch[2] };

  return null;
}

export async function detectOwnerRepo(
  repoRoot: string
): Promise<{ owner: string; repo: string } | null> {
  for (const remote of ['origin', 'upstream']) {
    const result = await runCommand('git', ['remote', 'get-url', remote], repoRoot);
    if (result.exitCode === 0) {
      const parsed = parseOwnerRepo(result.stdout.trim());
      if (parsed) return parsed;
    }
  }

  // Fall back to listing all remotes
  const listResult = await runCommand('git', ['remote'], repoRoot);
  if (listResult.exitCode !== 0) return null;

  for (const remote of listResult.stdout.trim().split('\n')) {
    const r = remote.trim();
    if (!r) continue;
    const result = await runCommand('git', ['remote', 'get-url', r], repoRoot);
    if (result.exitCode === 0) {
      const parsed = parseOwnerRepo(result.stdout.trim());
      if (parsed) return parsed;
    }
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubFetch(url: string, token: string | null, retries = 2): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.groot-preview+json',
    'User-Agent': 'vscode-pr-highlighter',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers });

    if (res.status === 403 || res.status === 429) {
      const resetHeader = res.headers.get('X-RateLimit-Reset');
      const waitMs = resetHeader
        ? Math.max(0, parseInt(resetHeader) * 1000 - Date.now()) + 1000
        : Math.min(1000 * Math.pow(2, attempt), 30_000);
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

    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

export async function fetchPrForCommit(
  ownerRepo: { owner: string; repo: string },
  sha: string
): Promise<PrInfo | null> {
  const cacheKey = `${ownerRepo.owner}/${ownerRepo.repo}:${sha}`;
  if (prCache.has(cacheKey)) return prCache.get(cacheKey)!;

  const token = await resolveToken();
  const url = `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${sha}/pulls`;
  const data = await githubFetch(url, token) as Array<{
    number: number;
    title: string;
    user: { login: string };
    merged_at: string;
    html_url: string;
  }> | null;

  if (!data || !Array.isArray(data) || data.length === 0) {
    prCache.set(cacheKey, null);
    return null;
  }

  const pr = data[0];
  const info: PrInfo = {
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
export async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
