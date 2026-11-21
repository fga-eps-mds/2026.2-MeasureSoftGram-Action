import axios, { AxiosInstance, AxiosResponse } from 'axios'

import { GithubMetricsResponse } from './github'
import GithubComment from './github/github-comment'
import { RequestService } from './service/request-service'
import Service, { CalculatedMsgram } from './service/service'
import Sonarqube, { MetricsResponseAPI } from './sonarqube'

/*
 * Coletor do MeasureSoftGram para o GitLab CI/CD: equivalente ao src/index.ts da Action do GitHub.
 *
 * Lê as variáveis nativas do GitLab Runner e os parâmetros do componente, coleta as métricas do SonarQube
 * e as métricas de processo pela API v4 do GitLab, envia tudo ao MeasureSoftGram-Service e, em pipelines de
 * Merge Request, publica (ou atualiza) uma Note com o resultado.
 *
 * As métricas de processo têm os mesmos nomes das coletadas no GitHub (total_issues, resolved_issues,
 * sum_ci_feedback_times, total_builds) e vão na chave `github` do payload, que é a única lida hoje pelo
 * Service; assim o cálculo é o mesmo nas duas plataformas.
 */

const COMMENT_MARKER = '## MeasureSoftGram Analysis Results'
const PER_PAGE = 100

export interface GitlabConfig {
  serverUrl: string
  projectId: string
  projectPath: string
  namespace: string
  projectName: string
  mergeRequestIid: number | null
  commitSha: string
  gitlabToken: string
  msgramServiceToken: string
  productName: string
  sonarHost: string
  sonarToken: string
  sonarProjectKey: string
  usLabel: string
  workflowName: string
  collectSonarqubeMetrics: boolean
  collectGitlabMetrics: boolean
}

type Env = Record<string, string | undefined>

function readFlag(env: Env, name: string): boolean {
  const value = (env[name] ?? '').trim().toLowerCase()
  return value === '' ? true : !['false', '0', 'no'].includes(value)
}

/** Lê a configuração do job. Só cita o nome das variáveis que faltam, nunca o valor de nenhuma. */
export function getGitlabConfig(env: Env = process.env): GitlabConfig {
  const read = (name: string) => (env[name] ?? '').trim()
  const collectGitlabMetrics = readFlag(env, 'COLLECT_GITLAB_METRICS')
  const mergeRequestIid = read('CI_MERGE_REQUEST_IID')

  const required = ['CI_SERVER_URL', 'CI_PROJECT_ID', 'CI_PROJECT_NAMESPACE', 'CI_PROJECT_NAME', 'MSGRAM_SERVICE_TOKEN', 'PRODUCT_NAME']
  // O token do GitLab é necessário para as métricas de processo e para comentar no Merge Request.
  if (collectGitlabMetrics || mergeRequestIid) {
    required.push('GITLAB_TOKEN')
  }
  const missing = required.filter(name => !read(name))
  if (missing.length > 0) {
    throw new Error(`Missing required variables: ${missing.join(', ')}. Configure them in the job or in the project CI/CD variables.`)
  }

  const namespace = read('CI_PROJECT_NAMESPACE')
  const projectName = read('CI_PROJECT_NAME')

  return {
    serverUrl: read('CI_SERVER_URL').replace(/\/+$/, ''),
    projectId: read('CI_PROJECT_ID'),
    projectPath: read('CI_PROJECT_PATH') || `${namespace}/${projectName}`,
    namespace,
    projectName,
    mergeRequestIid: mergeRequestIid ? Number(mergeRequestIid) : null,
    commitSha: read('CI_COMMIT_SHA'),
    gitlabToken: read('GITLAB_TOKEN'),
    msgramServiceToken: read('MSGRAM_SERVICE_TOKEN'),
    productName: read('PRODUCT_NAME'),
    sonarHost: read('SONAR_HOST'),
    sonarToken: read('SONAR_TOKEN'),
    sonarProjectKey: read('SONAR_PROJECT_KEY') || `${namespace.replace(/\//g, '_')}_${projectName}`,
    usLabel: read('US_LABEL'),
    workflowName: read('WORKFLOW_NAME'),
    collectSonarqubeMetrics: readFlag(env, 'COLLECT_SONARQUBE_METRICS'),
    collectGitlabMetrics,
  }
}

/** Troca cada segredo por *** no texto. */
export function maskSecrets(text: string, secrets: string[]): string {
  return secrets
    .filter(secret => secret.length >= 4)
    .reduce((masked, secret) => masked.split(secret).join('***'), text)
}

/**
 * Faz o console mascarar os segredos em tudo o que for para o log do job. As variáveis "masked" do GitLab
 * já fazem isso, mas não cobrem tokens passados sem a opção de mascarar nem valores fora do formato aceito.
 */
export function installSecretMasking(secrets: string[]): () => void {
  const { log, error, warn } = console
  const wrap = (original: (...args: unknown[]) => void) => (...args: unknown[]) =>
    original(...args.map(arg => maskSecrets(arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg), secrets)))
  console.log = wrap(log)
  console.error = wrap(error)
  console.warn = wrap(warn)
  return () => {
    console.log = log
    console.error = error
    console.warn = warn
  }
}

interface Pipeline {
  created_at: string
  updated_at: string
}

interface Note {
  id: number
  body: string
  system: boolean
  author: { id: number }
}

/** Cliente da API v4 do GitLab: métricas de processo e Notes do Merge Request. */
export class GitlabAPIService {
  private http: AxiosInstance
  private projectId: string

  constructor(config: Pick<GitlabConfig, 'serverUrl' | 'projectId' | 'gitlabToken'>) {
    this.projectId = encodeURIComponent(config.projectId)
    this.http = axios.create({
      baseURL: `${config.serverUrl}/api/v4`,
      timeout: 30000,
      headers: { 'PRIVATE-TOKEN': config.gitlabToken },
    })
  }

  /** Executa a requisição; em caso de erro, informa só método, rota e status, sem a configuração do axios (que traz o token). */
  private async request<T>(method: 'get' | 'post' | 'put', url: string, options: { params?: object; data?: object } = {}) {
    try {
      return await this.http.request<T>({ method, url, ...options })
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status ?? 'no response' : 'unexpected error'
      const hint = status === 401 || status === 403 ? ' Check that GITLAB_TOKEN is valid and has the api scope.' : ''
      throw new Error(`GitLab API ${method.toUpperCase()} ${url.split('?')[0]} failed (${status}).${hint}`)
    }
  }

  private async getAllPages<T>(url: string, params: object = {}): Promise<T[]> {
    const items: T[] = []
    let page: string | undefined = '1'
    while (page) {
      const response: AxiosResponse<T[]> = await this.request<T[]>('get', url, { params: { ...params, per_page: PER_PAGE, page } })
      items.push(...response.data)
      page = response.headers['x-next-page'] || undefined
    }
    return items
  }

  private async countIssues(params: object): Promise<number> {
    const url = `/projects/${this.projectId}/issues`
    const response = await this.request<unknown[]>('get', url, { params: { ...params, per_page: 1 } })
    const total = Number(response.headers['x-total'])
    // O GitLab omite o X-Total acima de 10 mil itens; nesse caso conta página a página.
    return Number.isFinite(total) && response.headers['x-total'] !== undefined ? total : (await this.getAllPages(url, params)).length
  }

  public async fetchProcessMetrics(beginDate: string, label: string, workflowName: string, path: string): Promise<GithubMetricsResponse> {
    const issueParams = { updated_after: beginDate, ...(label ? { labels: label } : {}) }
    const totalIssues = await this.countIssues(issueParams)
    const resolvedIssues = await this.countIssues({ ...issueParams, state: 'closed' })

    const pipelines = await this.getAllPages<Pipeline>(`/projects/${this.projectId}/pipelines`, workflowName ? { name: workflowName } : {})
    const sumFeedbackTimes = pipelines.reduce(
      (sum, pipeline) => sum + (new Date(pipeline.updated_at).getTime() - new Date(pipeline.created_at).getTime()) / 1000,
      0
    )

    return {
      metrics: [
        { name: 'sum_ci_feedback_times', value: sumFeedbackTimes, path },
        { name: 'total_builds', value: pipelines.length, path },
        { name: 'total_issues', value: totalIssues, path },
        { name: 'resolved_issues', value: resolvedIssues, path },
      ],
    }
  }

  /** Atualiza a Note do MeasureSoftGram feita pelo dono do token ou cria uma nova. */
  public async createOrUpdateNote(mergeRequestIid: number, body: string): Promise<'created' | 'updated'> {
    const { data: user } = await this.request<{ id: number }>('get', '/user')
    const notesUrl = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/notes`
    const notes = await this.getAllPages<Note>(notesUrl)
    const existing = notes.find(note => !note.system && note.author?.id === user.id && note.body.includes(COMMENT_MARKER))

    if (existing) {
      await this.request('put', `${notesUrl}/${existing.id}`, { data: { body } })
      return 'updated'
    }
    await this.request('post', notesUrl, { data: { body } })
    return 'created'
  }
}

export async function run(env: Env = process.env): Promise<void> {
  // Mascara os segredos antes de qualquer log, inclusive os de erro de configuração.
  const restoreConsole = installSecretMasking(
    ['GITLAB_TOKEN', 'MSGRAM_SERVICE_TOKEN', 'SONAR_TOKEN'].map(name => (env[name] ?? '').trim())
  )

  try {
    console.log('Iniciando coleta de métricas (GitLab CI)')
    const config = getGitlabConfig(env)

    const requestService = new RequestService()
    requestService.setMsgToken(config.msgramServiceToken)
    const service = new Service(config.projectName, config.namespace, config.productName, new Date())
    const releaseData = await service.checkReleaseExists(requestService)

    let sonarMetrics: MetricsResponseAPI | null = null
    if (config.collectSonarqubeMetrics) {
      const sonarqube = new Sonarqube({
        project: { sonarProjectKey: config.sonarProjectKey },
        host: config.sonarHost,
        token: config.sonarToken,
      })
      sonarMetrics = await sonarqube.getMeasures({ pageSize: 500, pullRequestNumber: null })
    } else {
      console.log('Coleta do SonarQube desativada (COLLECT_SONARQUBE_METRICS=false)')
    }

    const gitlabApi = config.gitlabToken ? new GitlabAPIService(config) : null
    let processMetrics: GithubMetricsResponse | null = null
    if (config.collectGitlabMetrics && gitlabApi) {
      console.log(`Coletando métricas de processo do GitLab: ${config.projectPath}`)
      processMetrics = await gitlabApi.fetchProcessMetrics(releaseData.startAt, config.usLabel, config.workflowName, config.projectPath)
    } else {
      console.log('Coleta de métricas do GitLab desativada (COLLECT_GITLAB_METRICS=false)')
    }

    const result: CalculatedMsgram[] = await service.calculateResults(
      requestService,
      sonarMetrics,
      processMetrics,
      releaseData.orgId,
      releaseData.productId,
      releaseData.repositoryId
    )

    if (config.mergeRequestIid && gitlabApi) {
      const message = new GithubComment().createMessage(result)
      const action = await gitlabApi.createOrUpdateNote(config.mergeRequestIid, message)
      console.log(`Comentário ${action === 'created' ? 'criado' : 'atualizado'} no Merge Request !${config.mergeRequestIid}`)
    } else {
      console.log('Pipeline sem Merge Request: métricas enviadas, nenhum comentário publicado')
    }
  } catch (error: unknown) {
    console.error(`MeasureSoftGram: ${error instanceof Error ? error.message : 'Unknown error'}`)
    process.exitCode = 1
  } finally {
    restoreConsole()
  }
}

// O GitLab Runner sempre define GITLAB_CI=true; nos testes a variável não existe e o run() é chamado direto.
if (process.env.GITLAB_CI === 'true') {
  void run()
}
