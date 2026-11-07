import * as core from '@actions/core';
import * as github from '@actions/github';
import Service from '../src/service/service';
import Sonarqube from '../src/sonarqube';
import GithubComment from '../src/github/github-comment';
import { RequestService } from '../src/service/request-service';

jest.mock('@actions/core');
jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'team', repo: 'product' }, payload: {} },
  getOctokit: jest.fn(),
}));
jest.mock('../src/service/service');
jest.mock('../src/sonarqube', () => ({
  __esModule: true, default: jest.fn(),
}));
jest.mock('../src/github', () => ({
  __esModule: true, default: jest.fn(() => ({ fetchGithubMetrics: jest.fn() })),
}));
jest.mock('../src/github/github-comment');
jest.mock('../src/service/request-service');

// Import triggers the action entrypoint once; subsequent cases call run explicitly.
import { run } from '../src/index';

beforeEach(() => {
  jest.clearAllMocks();
  (github.context.payload as any).pull_request = undefined;
  (Service.prototype.checkReleaseExists as jest.Mock).mockResolvedValue({
    startAt: '2026-01-01', orgId: 1, productId: 2, repositoryId: 3,
  });
  (Service.prototype.calculateResults as jest.Mock).mockResolvedValue({ value: 1 });
  (Sonarqube as jest.Mock).mockImplementation(() => ({ getMeasures: jest.fn().mockResolvedValue({ metrics: [] }) }));
});

test('collects metrics and calculates results', async () => {
  await run();
  expect(RequestService.prototype.setMsgToken).toHaveBeenCalled();
  expect((Sonarqube as jest.Mock).mock.results[0].value.getMeasures).toHaveBeenCalledWith({ pageSize: 500, pullRequestNumber: null });
  expect(Service.prototype.calculateResults).toHaveBeenCalledWith(
    expect.any(RequestService), { metrics: [] }, undefined, 1, 2, 3,
  );
  expect(core.setFailed).not.toHaveBeenCalled();
});

test('publishes results for a pull request', async () => {
  (github.context.payload as any).pull_request = { number: 42 };
  await run();
  expect(GithubComment.prototype.createMessage).toHaveBeenCalledWith({ value: 1 });
  expect(GithubComment.prototype.createOrUpdateComment).toHaveBeenCalledWith(42, undefined, undefined);
});

test.each([new Error('service unavailable'), 'unknown failure'])(
  'marks the action as failed when collection fails: %p', async error => {
    (Service.prototype.checkReleaseExists as jest.Mock).mockRejectedValue(error);
    await run();
    expect(core.setFailed).toHaveBeenCalledWith(error instanceof Error ? error.message : 'Unknown error');
  },
);
