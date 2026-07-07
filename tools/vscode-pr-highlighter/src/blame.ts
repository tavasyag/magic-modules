import * as cp from 'child_process';
import * as path from 'path';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
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
export function parsePorcelain(raw: string): Map<number, string> {
  const lineToSha = new Map<number, string>();
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
    } else {
      i++;
    }
  }

  return lineToSha;
}

export async function findRepoRoot(filePath: string): Promise<string | null> {
  const dir = path.dirname(filePath);
  const result = await runCommand('git', ['rev-parse', '--show-toplevel'], dir);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

// Returns null if the file has no git history (untracked, new, or binary).
export async function getBlameData(
  filePath: string,
  repoRoot: string
): Promise<Map<number, string> | null> {
  const result = await runCommand('git', ['blame', '--porcelain', filePath], repoRoot);
  if (result.exitCode !== 0) return null;
  if (!result.stdout.trim()) return null;
  return parsePorcelain(result.stdout);
}
