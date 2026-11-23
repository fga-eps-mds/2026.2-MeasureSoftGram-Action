import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import Service from '../src/service/service';
import Sonarqube from '../src/sonarqube';
import GithubComment from '../src/github/github-comment';
import { RequestService } from '../src/service/request-service';
import { GitlabAPIService, getGitlabConfig, installSecretMasking, maskSecrets, run } from '../src/gitlab';

jest.mock('../src/service/service');
jest.mock('../src/service/request-service');
jest.mock('../src/sonarqube', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/github/github-comment');

const API = 'https://gitlab.example.com/api/v4';
const PROJECT = `${API}/projects/42`;

const baseEnv = {
  CI_SERVER_URL: 'https://gitlab.example.com/',
  CI_PROJECT_ID: '42',
  CI_PROJECT_NAMESPACE: 'fga-eps-mds',
  CI_PROJECT_NAME: 'meu-projeto',
  CI_PROJECT_PATH: 'fga-eps-mds/meu-projeto',
  CI_COMMIT_SHA: 'abc123',
  GITLAB_TOKEN: 'glpat-super-secret',
  MSGRAM_SERVICE_TOKEN: 'msg-super-secret',
  PRODUCT_NAME: 'MeasureSoftGram',
  SONAR_TOKEN: 'sonar-super-secret',
};

const result = [{ tsqmi: [{ key: 'tsqmi', value: 0.8 }], characteristics: [] }];

let mock: MockAdapter;
let getMeasures: jest.Mock;
let logs: string[];

beforeEach(() => {
  jest.clearAllMocks();
  mock = new MockAdapter(axios);
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')); });
  process.exitCode = undefined;

  (Service.prototype.checkReleaseExists as jest.Mock).mockResolvedValue({
    startAt: '2026-08-01T00:00:00Z', orgId: 1, productId: 2, repositoryId: 3,
  });
  (Service.prototype.calculateResults as jest.Mock).mockResolvedValue(result);
  getMeasures = jest.fn().mockResolvedValue({ components: [] });
  (Sonarqube as unknown as jest.Mock).mockImplementation(() => ({ getMeasures }));
  (GithubComment.prototype.createMessage as jest.Mock).mockReturnValue('## MeasureSoftGram Analysis Results\nnovo');
});

afterEach(() => {
  mock.restore();
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

function mockProcessMetrics() {
  mock.onGet(`${PROJECT}/issues`).reply(config =>
    [200, [], { 'x-total': config.params.state === 'closed' ? '3' : '10' }]
  );
  mock.onGet(`${PROJECT}/pipelines`).replyOnce(200, [
    { created_at: '2026-08-02T10:00:00Z', updated_at: '2026-08-02T10:05:00Z' },
  ], { 'x-next-page': '2' });
  mock.onGet(`${PROJECT}/pipelines`).replyOnce(200, [
    { created_at: '2026-08-03T10:00:00Z', updated_at: '2026-08-03T10:01:00Z' },
  ], { 'x-next-page': '' });
}

describe('getGitlabConfig', () => {
  test('lê as variáveis do runner e aplica os valores padrão', () => {
    const config = getGitlabConfig({ ...baseEnv, CI_PROJECT_NAMESPACE: 'grupo/sub', CI_MERGE_REQUEST_IID: '7' });

    expect(config.serverUrl).toBe('https://gitlab.example.com');
    expect(config.mergeRequestIid).toBe(7);
    expect(config.sonarProjectKey).toBe('grupo_sub_meu-projeto');
    expect(config.collectSonarqubeMetrics).toBe(true);
    expect(config.collectGitlabMetrics).toBe(true);
  });

  test('desliga as coletas com as flags em false', () => {
    const config = getGitlabConfig({ ...baseEnv, COLLECT_SONARQUBE_METRICS: 'false', COLLECT_GITLAB_METRICS: 'FALSE' });

    expect(config.collectSonarqubeMetrics).toBe(false);
    expect(config.collectGitlabMetrics).toBe(false);
  });

  test('aponta as variáveis obrigatórias que faltam', () => {
    expect(() => getGitlabConfig({ ...baseEnv, MSGRAM_SERVICE_TOKEN: '', GITLAB_TOKEN: ' ' }))
      .toThrow('Missing required variables: MSGRAM_SERVICE_TOKEN, GITLAB_TOKEN.');
  });

  test('não exige o GITLAB_TOKEN sem métricas do GitLab e fora de Merge Request', () => {
    expect(() => getGitlabConfig({ ...baseEnv, GITLAB_TOKEN: '', COLLECT_GITLAB_METRICS: 'false' })).not.toThrow();
  });
});

describe('mascaramento de segredos', () => {
  test('maskSecrets troca os segredos e ignora valores vazios', () => {
    expect(maskSecrets('token=glpat-super-secret', ['glpat-super-secret', ''])).toBe('token=***');
  });

  test('installSecretMasking mascara o console e restaura ao final', () => {
    const restore = installSecretMasking(['glpat-super-secret']);
    console.log('header', { 'PRIVATE-TOKEN': 'glpat-super-secret' });
    console.error(new Error('falhou com glpat-super-secret'));
    restore();

    expect(logs).toEqual(['header {"PRIVATE-TOKEN":"***"}', 'falhou com ***']);
  });
});

describe('GitlabAPIService', () => {
  const api = () => new GitlabAPIService({ serverUrl: 'https://gitlab.example.com', projectId: '42', gitlabToken: 'glpat-super-secret' });

  test('coleta issues e pipelines com os mesmos nomes de métricas do GitHub', async () => {
    mockProcessMetrics();

    const metrics = await api().fetchProcessMetrics('2026-08-01T00:00:00Z', 'US', 'release', 'fga-eps-mds/meu-projeto');

    expect(metrics.metrics).toEqual([
      { name: 'sum_ci_feedback_times', value: 360, path: 'fga-eps-mds/meu-projeto' },
      { name: 'total_builds', value: 2, path: 'fga-eps-mds/meu-projeto' },
      { name: 'total_issues', value: 10, path: 'fga-eps-mds/meu-projeto' },
      { name: 'resolved_issues', value: 3, path: 'fga-eps-mds/meu-projeto' },
    ]);
    const issuesCall = mock.history.get.find(call => call.url?.endsWith('/projects/42/issues'));
    expect(issuesCall?.params).toMatchObject({ updated_after: '2026-08-01T00:00:00Z', labels: 'US' });
    expect(issuesCall?.headers?.['PRIVATE-TOKEN']).toBe('glpat-super-secret');
    expect(mock.history.get.find(call => call.url?.endsWith('/projects/42/pipelines'))?.params).toMatchObject({ name: 'release' });
  });

  test('conta as issues página a página quando o GitLab omite o X-Total', async () => {
    mock.onGet(`${PROJECT}/issues`).reply(config =>
      config.params.per_page === 1 ? [200, [{}]] : [200, [{}, {}], { 'x-next-page': '' }]
    );
    mock.onGet(`${PROJECT}/pipelines`).reply(200, [], { 'x-next-page': '' });

    const metrics = await api().fetchProcessMetrics('2026-08-01', '', '', 'p');

    expect(metrics.metrics.find(metric => metric.name === 'total_issues')?.value).toBe(2);
  });

  test('o erro da API cita rota e status, sem o token', async () => {
    mock.onGet(`${PROJECT}/issues`).reply(401);

    const promise = api().fetchProcessMetrics('2026-08-01', '', '', 'p');

    await expect(promise).rejects.toThrow('GitLab API GET /projects/42/issues failed (401). Check that GITLAB_TOKEN is valid and has the api scope.');
    await expect(promise).rejects.not.toThrow('glpat');
  });

  test('atualiza a Note existente do dono do token', async () => {
    mock.onGet(`${API}/user`).reply(200, { id: 5 });
    mock.onGet(`${PROJECT}/merge_requests/7/notes`).reply(200, [
      { id: 1, system: false, author: { id: 9 }, body: '## MeasureSoftGram Analysis Results\nde outra pessoa' },
      { id: 2, system: false, author: { id: 5 }, body: '## MeasureSoftGram Analysis Results\nantigo' },
    ], { 'x-next-page': '' });
    mock.onPut(`${PROJECT}/merge_requests/7/notes/2`).reply(200);

    await expect(api().createOrUpdateNote(7, 'novo')).resolves.toBe('updated');
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ body: 'novo' });
  });

  test('cria uma Note quando ainda não existe', async () => {
    mock.onGet(`${API}/user`).reply(200, { id: 5 });
    mock.onGet(`${PROJECT}/merge_requests/7/notes`).reply(200, [], { 'x-next-page': '' });
    mock.onPost(`${PROJECT}/merge_requests/7/notes`).reply(201);

    await expect(api().createOrUpdateNote(7, 'novo')).resolves.toBe('created');
    expect(mock.history.post).toHaveLength(1);
  });
});

describe('run', () => {
  test('em Merge Request, coleta tudo, envia ao Service e comenta no MR', async () => {
    mockProcessMetrics();
    mock.onGet(`${API}/user`).reply(200, { id: 5 });
    mock.onGet(`${PROJECT}/merge_requests/7/notes`).reply(200, [], { 'x-next-page': '' });
    mock.onPost(`${PROJECT}/merge_requests/7/notes`).reply(201);

    await run({ ...baseEnv, CI_MERGE_REQUEST_IID: '7' });

    expect(process.exitCode).toBeUndefined();
    expect(RequestService.prototype.setMsgToken).toHaveBeenCalledWith('msg-super-secret');
    expect(Service).toHaveBeenCalledWith('meu-projeto', 'fga-eps-mds', 'MeasureSoftGram', expect.any(Date));
    expect(Sonarqube).toHaveBeenCalledWith({ project: { sonarProjectKey: 'fga-eps-mds_meu-projeto' }, host: '', token: 'sonar-super-secret' });
    expect(Service.prototype.calculateResults).toHaveBeenCalledWith(
      expect.any(RequestService), { components: [] }, expect.objectContaining({ metrics: expect.any(Array) }), 1, 2, 3
    );
    expect(GithubComment.prototype.createMessage).toHaveBeenCalledWith(result);
    expect(mock.history.post).toHaveLength(1);
  });

  test('na branch padrão, envia as métricas e termina sem comentar', async () => {
    mockProcessMetrics();

    await run(baseEnv);

    expect(process.exitCode).toBeUndefined();
    expect(Service.prototype.calculateResults).toHaveBeenCalled();
    expect(mock.history.post).toHaveLength(0);
    expect(logs).toContain('Pipeline sem Merge Request: métricas enviadas, nenhum comentário publicado');
  });

  test('com COLLECT_GITLAB_METRICS=false não chama a API do GitLab', async () => {
    await run({ ...baseEnv, COLLECT_GITLAB_METRICS: 'false' });

    expect(mock.history.get).toHaveLength(0);
    expect(Service.prototype.calculateResults).toHaveBeenCalledWith(expect.any(RequestService), { components: [] }, null, 1, 2, 3);
  });

  test('com COLLECT_SONARQUBE_METRICS=false não consulta o SonarQube', async () => {
    mockProcessMetrics();

    await run({ ...baseEnv, COLLECT_SONARQUBE_METRICS: 'false' });

    expect(getMeasures).not.toHaveBeenCalled();
    expect(Service.prototype.calculateResults).toHaveBeenCalledWith(expect.any(RequestService), null, expect.anything(), 1, 2, 3);
  });

  test('falha com mensagem clara e sem expor segredos', async () => {
    (Service.prototype.checkReleaseExists as jest.Mock).mockRejectedValue(new Error('token msg-super-secret inválido'));

    await run(baseEnv);

    expect(process.exitCode).toBe(1);
    expect(logs).toContain('MeasureSoftGram: token *** inválido');
    expect(logs.join('\n')).not.toMatch(/super-secret/);
  });

  test('falha quando falta variável obrigatória', async () => {
    await run({ ...baseEnv, PRODUCT_NAME: '' });

    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('Missing required variables: PRODUCT_NAME.');
    expect(Service.prototype.checkReleaseExists).not.toHaveBeenCalled();
  });
});
