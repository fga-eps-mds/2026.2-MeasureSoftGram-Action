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

  test('keeps throughput when workflow collection fails', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { total_count: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { total_count: 2 } })
      .mockRejectedValueOnce(new Error('unavailable'));
    const result = await new GithubAPIService(info).fetchGithubMetrics('Tests');
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics.map(metric => metric.name)).toEqual(['total_issues', 'resolved_issues']);
  });
});
