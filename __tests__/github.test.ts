import axios from 'axios';
import GithubAPIService from '../src/github';

jest.mock('axios');
const get = axios.get as jest.Mock;

const info = {
  owner: 'team', repo: 'product', label: 'story', token: 'secret',
  beginDate: '2026-01-01',
};

describe('GitHub metrics collection', () => {
  beforeEach(() => get.mockReset());

  test('collects throughput and paginates workflow runs, filtering by workflow name', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { total_count: 3 } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 8 } })
      .mockResolvedValueOnce({ status: 200, data: {
        total_count: 101,
        workflow_runs: [
          { name: 'Tests', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z' },
          { name: 'Deploy', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:10:00Z' },
        ],
      } })
      .mockResolvedValueOnce({ status: 200, data: {
        workflow_runs: [
          { name: 'Tests', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:02:00Z' },
        ],
      } });
    const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');
    expect(result.metrics).toEqual([
      { name: 'sum_ci_feedback_times', value: 180, path: 'team/product' },
      { name: 'total_builds', value: 2, path: 'team/product' },
      { name: 'total_issues', value: 8, path: 'team/product' },
      { name: 'resolved_issues', value: 3, path: 'team/product' },
    ]);
    expect(get.mock.calls[0][0]).toContain('label:story');
    expect(get.mock.calls[3][0]).toContain('page=2');
    expect(get.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });

  test('reports zero builds for an empty workflow history without a token or label', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { total_count: 0 } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 0 } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 0 } });
    const result = await new GithubAPIService({ ...info, label: '', token: '' }).fetchGithubMetrics('Tests');
    expect(result.metrics.find(metric => metric.name === 'total_builds')?.value).toBe(0);
    expect(get.mock.calls[0][0]).not.toContain('label:');
    expect(get.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  test('rejects unavailable issue metrics', async () => {
    get.mockRejectedValue(new Error('unavailable'));
    await expect(new GithubAPIService(info).fetchGithubMetrics('Tests')).rejects.toThrow('Error getting project measures');
  });

  test.each([403, 429, 500])('rejects issue metrics returned with HTTP %i', async status => {
    get.mockResolvedValueOnce({ status, data: { message: 'API request failed' } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 2 } });

    await expect(new GithubAPIService(info).fetchGithubMetrics('Tests')).rejects.toThrow(
      'Error getting project measures from GitHub'
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.some(([url]) => url.includes('/actions/runs'))).toBe(false);
  });

  describe('security alerts (SCM)', () => {
    // As quatro primeiras respostas cobrem as chamadas de issues e de
    // workflow runs; a partir da quinta vem /dependabot/alerts.
    const mockIssuesAndRuns = () =>
      get.mockResolvedValueOnce({ status: 200, data: { total_count: 1 } })
        .mockResolvedValueOnce({ status: 200, data: { total_count: 2 } })
        .mockResolvedValueOnce({ status: 200, data: { total_count: 0, workflow_runs: [] } });

    const securityMetrics = (metrics: Array<{ name: string; value: number | string | null }>) =>
      metrics.filter(metric => metric.name.startsWith('security_alerts'));

    test('counts open and closed alerts', async () => {
      mockIssuesAndRuns().mockResolvedValueOnce({ status: 200, data: [
        { number: 1, state: 'open' },
        { number: 2, state: 'fixed' },
        { number: 3, state: 'dismissed' },
        { number: 4, state: 'open' },
      ] });

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([
        { name: 'security_alerts_open', value: 2, path: 'team/product' },
        { name: 'security_alerts_closed', value: 2, path: 'team/product' },
      ]);
      expect(get.mock.calls.some(([url]) => url.includes('/dependabot/alerts'))).toBe(true);
    });

    test('reports zero alerts for a repository without any alert', async () => {
      mockIssuesAndRuns().mockResolvedValueOnce({ status: 200, data: [] });

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([
        { name: 'security_alerts_open', value: 0, path: 'team/product' },
        { name: 'security_alerts_closed', value: 0, path: 'team/product' },
      ]);
    });

    test('paginates the alert list', async () => {
      const fullPage = Array.from({ length: 100 }, (_, index) => ({ number: index, state: 'open' }));
      mockIssuesAndRuns()
        .mockResolvedValueOnce({ status: 200, data: fullPage })
        .mockResolvedValueOnce({ status: 200, data: [{ number: 100, state: 'fixed' }] });

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([
        { name: 'security_alerts_open', value: 100, path: 'team/product' },
        { name: 'security_alerts_closed', value: 1, path: 'team/product' },
      ]);
      expect(get.mock.calls.filter(([url]) => url.includes('/dependabot/alerts'))).toHaveLength(2);
    });

    test.each([403, 404])('omits the metrics when alerts answer HTTP %i, without breaking the run', async status => {
      mockIssuesAndRuns().mockResolvedValueOnce({ status, data: { message: 'Dependabot alerts are disabled' } });

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([]);
      expect(result.metrics.map(metric => metric.name)).toEqual([
        'sum_ci_feedback_times',
        'total_builds',
        'total_issues',
        'resolved_issues',
      ]);
    });

    test('omits the metrics when the alerts request fails', async () => {
      mockIssuesAndRuns().mockRejectedValueOnce(new Error('unavailable'));

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([]);
    });

    test('omits the metrics when the alerts payload is not a list', async () => {
      mockIssuesAndRuns().mockResolvedValueOnce({ status: 200, data: { message: 'unexpected' } });

      const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');

      expect(securityMetrics(result.metrics)).toEqual([]);
    });
  });

  test('keeps throughput when workflow collection fails', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { total_count: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 2 } })
      .mockRejectedValueOnce(new Error('unavailable'));
    const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics.map(metric => metric.name)).toEqual(['total_issues', 'resolved_issues']);
  });
});
