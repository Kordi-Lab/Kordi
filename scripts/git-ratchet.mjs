import { execFileSync } from 'node:child_process';

export function gitOutput(repoRoot, args, {
  ignoreErrors = false,
} = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', ignoreErrors ? 'ignore' : 'inherit'],
  });
}

export function resolveGitComparison(repoRoot, diffRange, {
  defaultBaseRef = 'origin/main',
} = {}) {
  if (!diffRange) {
    try {
      gitOutput(repoRoot, ['rev-parse', '--verify', '--quiet', defaultBaseRef], {
        ignoreErrors: true,
      });
      const mergeBase = gitOutput(repoRoot, [
        'merge-base',
        'HEAD',
        defaultBaseRef,
      ]).trim();
      return {
        baseCommit: mergeBase,
        diffRange: mergeBase,
      };
    } catch {
      return {
        baseCommit: 'HEAD',
        diffRange: 'HEAD',
      };
    }
  }

  if (diffRange.includes('...')) {
    const [left, right] = diffRange.split('...', 2);
    return {
      baseCommit: gitOutput(repoRoot, ['merge-base', left, right]).trim(),
      diffRange,
    };
  }
  if (diffRange.includes('..')) {
    return {
      baseCommit: diffRange.split('..', 1)[0],
      diffRange,
    };
  }
  return {
    baseCommit: diffRange,
    diffRange,
  };
}

export function readTextAtCommit(repoRoot, commit, relativePath) {
  if (!relativePath) return undefined;
  try {
    return gitOutput(repoRoot, ['show', `${commit}:${relativePath}`], {
      ignoreErrors: true,
    });
  } catch {
    return undefined;
  }
}
