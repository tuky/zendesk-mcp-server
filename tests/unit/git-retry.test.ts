import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/git-retry/git` stands in for git on PATH during semantic-release, so
 * a transient GitHub refusal of one push (the 3.3.1 note, `remote: fatal error
 * in commit_refs`) no longer ends a release halfway.
 */

const repoRoot = new URL('../../', import.meta.url);
const wrapper = fileURLToPath(new URL('scripts/git-retry/git', repoRoot));

const FAKE_GIT = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
n=$(wc -l < "$CALLS")
if [ "$n" -le "\${FAIL_TIMES:-0}" ]; then
  echo "remote: fatal error in commit_refs" >&2
  exit 1
fi
echo ok
`;

let sandbox: string;
let calls: string;
let realGit: string;

const run = (args: string[], failTimes = 0) =>
  spawnSync(wrapper, args, {
    env: {
      ...process.env,
      REAL_GIT: realGit,
      CALLS: calls,
      FAIL_TIMES: String(failTimes),
      GIT_PUSH_RETRY_DELAYS: '0 0 0',
    },
    encoding: 'utf8',
  });

const loggedCalls = () => readFileSync(calls, 'utf8').trimEnd().split('\n');

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'git-retry-'));
  calls = join(sandbox, 'calls.log');
  realGit = join(sandbox, 'git');
  writeFileSync(calls, '');
  writeFileSync(realGit, FAKE_GIT);
  chmodSync(realGit, 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('git retry wrapper (scripts/git-retry/git)', () => {
  it('passes any command but push straight through, failures included', () => {
    const result = run(['tag', 'v1.2.3', 'HEAD'], 1);
    expect(result.status).toBe(1);
    expect(loggedCalls()).toEqual(['tag v1.2.3 HEAD']);
  });

  it('runs a push that succeeds once, with its arguments untouched', () => {
    const result = run(['push', '--', 'https://example/repo.git', 'refs/notes/x']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(loggedCalls()).toEqual(['push -- https://example/repo.git refs/notes/x']);
  });

  it('does not retry a dry-run push, which semantic-release expects to fail', () => {
    const result = run(
      ['push', '--dry-run', '--no-verify', '--', 'https://example/repo.git', 'HEAD:main'],
      9,
    );
    expect(result.status).toBe(1);
    expect(loggedCalls()).toEqual([
      'push --dry-run --no-verify -- https://example/repo.git HEAD:main',
    ]);
    expect(result.stderr).not.toContain('git push failed');
  });

  it('retries a failed push with the same arguments until it succeeds', () => {
    const result = run(['push', '--tags', 'origin', 'HEAD:main'], 2);
    expect(result.status).toBe(0);
    expect(loggedCalls()).toEqual(new Array(3).fill('push --tags origin HEAD:main'));
    expect(result.stderr).toContain('git push failed (attempt 1 of 4)');
  });

  it('gives up after four attempts with the last failure', () => {
    const result = run(['push', 'origin'], 9);
    expect(result.status).toBe(1);
    expect(loggedCalls()).toHaveLength(4);
    expect(result.stderr).toContain('remote: fatal error in commit_refs');
  });

  it('refuses to run without REAL_GIT, rather than calling itself', () => {
    const result = spawnSync(wrapper, ['status'], {
      env: { ...process.env, REAL_GIT: '' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REAL_GIT');
  });
});

describe('fork release workflow', () => {
  const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');

  it('publishes only from fork release tags, not automatically from main', () => {
    expect(workflow).toMatch(/on:\s*push:\s*tags:\s*\['fork-v\*'\]/);
    expect(workflow).not.toContain('semantic-release');
    expect(workflow).not.toMatch(/branches:\s*\[main\]/);
  });

  it('runs verification before publishing the image and archive', () => {
    const checks = workflow.indexOf('pnpm check && pnpm typecheck && pnpm test && pnpm build');
    const publish = workflow.indexOf('Publish reviewed tag image and source package');
    expect(checks).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(checks);
    expect(workflow).toContain('docker push "$IMAGE"');
    expect(workflow).toContain('gh release create "$TAG"');
  });

  it('validates an annotated, version-matched tag on main before privileged publishing', () => {
    expect(workflow).toContain('validate-tag:');
    expect(workflow).toContain('git merge-base --is-ancestor "$COMMIT" FETCH_HEAD');
    expect(workflow).toContain('git cat-file -t "refs/tags/$TAG"');
    expect(workflow).toMatch(/tag !== `fork-v\$\{packageJson\.version\}`/);
    expect(workflow).toMatch(/publish:\s+needs: validate-tag/);
    expect(workflow).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    expect(workflow).toMatch(/git ls-remote origin "refs\/tags\/\$\{TAG\}\^\{\}"/);
  });
});

describe('fork packaging', () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', repoRoot), 'utf8');
  const containerSmoke = readFileSync(new URL('scripts/container-smoke.mjs', repoRoot), 'utf8');

  it('uses the fork package name in the Node 22 tarball smoke test', () => {
    expect(ci).toContain('node_modules/@tuky/zendesk-mcp-server');
    expect(ci).not.toContain('node_modules/@fruggr/zendesk-mcp-server');
  });

  it('checks the startup error link against the fork documentation', () => {
    expect(containerSmoke).toContain('github\\.com\\/tuky\\/zendesk-mcp-server');
    expect(containerSmoke).not.toContain('github\\.com\\/fruggr\\/zendesk-mcp-server');
  });
});
