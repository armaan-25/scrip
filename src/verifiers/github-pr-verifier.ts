import type { HttpFetch } from '../ramp-oauth.js';
import type { OutcomeEvidence } from '../store.js';
import type { OutcomeVerifier } from '../outcome-verifier.js';

export interface GithubPrVerificationRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Require these named checks (from GET /commits/{ref}/check-runs) to have concluded 'success'. Empty = don't check CI. */
  requiredChecks?: string[];
}

interface GithubPullResponse {
  merged: boolean;
  merge_commit_sha: string | null;
  base: { ref: string };
  head: { sha: string };
}

interface GithubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GithubCheckRunsResponse {
  check_runs: GithubCheckRun[];
}

/**
 * Verifies a job's outcome against real GitHub state - "PR merged" and
 * "required checks passed" - rather than the worker's own narrative.
 * Endpoints and field names confirmed against GitHub's current REST API
 * docs (docs.github.com/en/rest/pulls/pulls, .../rest/checks/runs), not
 * guessed. Unit-tested with a fake fetch only, same DI pattern as every
 * other real-API integration in this project (RampOAuthClient, Meter) -
 * not yet live-verified against a real repository/token, since no
 * GITHUB_TOKEN is configured in this environment. See docs/OUTCOME_VERIFICATION.md.
 */
export class GithubPrOutcomeVerifier implements OutcomeVerifier<GithubPrVerificationRequest> {
  readonly type = 'github_pr';

  constructor(private token: string, private fetchFn: HttpFetch = fetch, private baseUrl = 'https://api.github.com') {}

  async verify(request: GithubPrVerificationRequest): Promise<OutcomeEvidence> {
    const pr = await this.getJson<GithubPullResponse>(
      `/repos/${request.owner}/${request.repo}/pulls/${request.pullNumber}`
    );

    if (!pr.merged) {
      return {
        type: this.type,
        description: `PR #${request.pullNumber} is not merged`,
        verifiedAt: new Date().toISOString(),
        data: { merged: false, owner: request.owner, repo: request.repo, pullNumber: request.pullNumber },
      };
    }

    const requiredChecks = request.requiredChecks ?? [];
    let checksPassed = true;
    let checkRuns: GithubCheckRun[] = [];
    if (requiredChecks.length > 0) {
      const checks = await this.getJson<GithubCheckRunsResponse>(
        `/repos/${request.owner}/${request.repo}/commits/${pr.head.sha}/check-runs`
      );
      checkRuns = checks.check_runs.filter((run) => requiredChecks.includes(run.name));
      checksPassed = requiredChecks.every((name) =>
        checkRuns.some((run) => run.name === name && run.status === 'completed' && run.conclusion === 'success')
      );
    }

    const success = pr.merged && checksPassed;
    return {
      type: this.type,
      description: success
        ? `PR #${request.pullNumber} merged into ${pr.base.ref}${requiredChecks.length ? ' with all required checks passing' : ''}`
        : `PR #${request.pullNumber} merged into ${pr.base.ref}, but not all required checks passed`,
      verifiedAt: new Date().toISOString(),
      data: {
        merged: true,
        mergeCommitSha: pr.merge_commit_sha,
        baseBranch: pr.base.ref,
        checksPassed,
        checkRuns: checkRuns.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion })),
      },
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '<no response body>');
      throw new Error(`GitHub API request to ${path} failed with status ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  }
}
