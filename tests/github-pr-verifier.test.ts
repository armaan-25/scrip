import { describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '../src/ramp-oauth.js';
import { GithubPrOutcomeVerifier } from '../src/verifiers/github-pr-verifier.js';

function fakeFetch(responses: Record<string, unknown>): HttpFetch {
  return vi.fn(async (url) => {
    const path = url.toString().replace('https://api.github.com', '');
    const body = responses[path];
    if (!body) throw new Error(`fakeFetch: no stub for ${path}`);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as HttpFetch;
}

describe('GithubPrOutcomeVerifier', () => {
  it('reports not merged when the PR has not been merged', async () => {
    const fetchFn = fakeFetch({
      '/repos/acme/widgets/pulls/418': { merged: false, merge_commit_sha: null, base: { ref: 'main' }, head: { sha: 'abc123' } },
    });
    const verifier = new GithubPrOutcomeVerifier('token', fetchFn);

    const evidence = await verifier.verify({ owner: 'acme', repo: 'widgets', pullNumber: 418 });

    expect(evidence.type).toBe('github_pr');
    expect(evidence.description).toContain('not merged');
    expect(evidence.data).toMatchObject({ merged: false });
  });

  it('reports success when merged and no required checks are requested', async () => {
    const fetchFn = fakeFetch({
      '/repos/acme/widgets/pulls/418': {
        merged: true,
        merge_commit_sha: 'deadbeef',
        base: { ref: 'main' },
        head: { sha: 'abc123' },
      },
    });
    const verifier = new GithubPrOutcomeVerifier('token', fetchFn);

    const evidence = await verifier.verify({ owner: 'acme', repo: 'widgets', pullNumber: 418 });

    expect(evidence.description).toContain('merged into main');
    expect(evidence.data).toMatchObject({ merged: true, mergeCommitSha: 'deadbeef', baseBranch: 'main', checksPassed: true });
  });

  it('reports success only when every required check has status completed and conclusion success', async () => {
    const fetchFn = fakeFetch({
      '/repos/acme/widgets/pulls/418': {
        merged: true,
        merge_commit_sha: 'deadbeef',
        base: { ref: 'main' },
        head: { sha: 'abc123' },
      },
      '/repos/acme/widgets/commits/abc123/check-runs': {
        check_runs: [
          { name: 'ci/build', status: 'completed', conclusion: 'success' },
          { name: 'ci/test', status: 'completed', conclusion: 'success' },
          { name: 'ci/lint', status: 'completed', conclusion: 'failure' },
        ],
      },
    });
    const verifier = new GithubPrOutcomeVerifier('token', fetchFn);

    const evidence = await verifier.verify({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 418,
      requiredChecks: ['ci/build', 'ci/test'],
    });

    expect(evidence.data).toMatchObject({ checksPassed: true });

    const evidenceWithLint = await verifier.verify({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 418,
      requiredChecks: ['ci/build', 'ci/lint'],
    });
    expect(evidenceWithLint.data).toMatchObject({ checksPassed: false });
    expect(evidenceWithLint.description).toContain('not all required checks passed');
  });

  it('sends the real GitHub API headers (Authorization, Accept, X-GitHub-Api-Version)', async () => {
    const captured: { headers?: unknown } = {};
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.headers = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ merged: false, merge_commit_sha: null, base: { ref: 'main' }, head: { sha: 'abc' } }),
      } as Response;
    }) as unknown as HttpFetch;
    const verifier = new GithubPrOutcomeVerifier('my-token', fetchFn);

    await verifier.verify({ owner: 'acme', repo: 'widgets', pullNumber: 1 });

    expect(captured.headers).toMatchObject({
      Authorization: 'Bearer my-token',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('throws with the response body included when the GitHub API request fails', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'Not Found' }),
    })) as unknown as HttpFetch;
    const verifier = new GithubPrOutcomeVerifier('token', fetchFn);

    await expect(verifier.verify({ owner: 'acme', repo: 'widgets', pullNumber: 999 })).rejects.toThrow(/404/);
    await expect(verifier.verify({ owner: 'acme', repo: 'widgets', pullNumber: 999 })).rejects.toThrow(/Not Found/);
  });
});
