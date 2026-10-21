import axios, { AxiosInstance } from 'axios';

import { Info } from './utils';

const MEASURES_ERROR_MESSAGE = 'Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.'

export interface MetricsResponseAPI {
  paging: {
      pageIndex: number
      pageSize: number
      total: number
  },
  baseComponent : {
      id: string
      key: string
      name: string
      qualifier: string
      measures: [unknown]
  },
  components: {
      id: string
      key: string
      name: string
      qualifier: string
      path: string
      language: string
      measures: unknown
  }[],
}

export default class Sonarqube {
  private http: AxiosInstance
  public host: string
  private token: string
  public project: {
    sonarProjectKey: string
  }
  public sonarMetrics = [
      'files',
      'sqale_debt_ratio',
      'functions',
      'complexity',
      'comment_lines_density',
      'duplicated_lines_density',
      'coverage',
      'ncloc',
      'tests',
      'test_errors',
      'test_failures',
      'test_execution_time',
      'security_rating',
      'test_success_density',
      'reliability_rating',
  ]

  constructor(info: Info) {
    this.host = info.host || 'https://sonarcloud.io'
    this.token = info.token
    this.project = info.project
    const tokenb64 = Buffer.from(`${this.token}:`).toString('base64')

    console.log(`SonarQube host: ${this.host}`)
    console.log(`SonarQube project: ${this.project.sonarProjectKey}`)

    this.http = axios.create({
        baseURL: this.host,
        timeout: 10000,
        headers: {
          Authorization: this.token ? `Basic ${tokenb64}` : "",
        }
    })
  }

  public getMeasures = async ({pageSize, pullRequestNumber}: {
      pageSize: number,
      pullRequestNumber: number | null
    }): Promise<MetricsResponseAPI> => {
    let page = 1
    try {
      let sonar_url = `/api/measures/component_tree?component=${this.project.sonarProjectKey}&metricKeys=${this.sonarMetrics.join(',')}&ps=${pageSize}`

      if (pullRequestNumber) {
        sonar_url += `&pullRequest=${pullRequestNumber}`;
      }
      console.log(`SonarQube URL: ${sonar_url}`)

      const firstPage = await this.getMeasuresPage(sonar_url, page)
      const components = [...firstPage.components]
      const { paging } = firstPage
      const totalPages = paging && paging.pageSize > 0 ? Math.ceil(paging.total / paging.pageSize) : 1

      for (page = 2; page <= totalPages; page++) {
        const nextPage = await this.getMeasuresPage(sonar_url, page)
        components.push(...nextPage.components)
      }

      console.log(`SonarQube components: ${components.length} of ${paging?.total} (${Math.max(totalPages, 1)} page(s))`)

      return { ...firstPage, components }
    } catch (err) {
      console.error(`Error getting SonarQube measures page ${page}: ${err instanceof Error ? err.message : String(err)}`)
      throw new Error(MEASURES_ERROR_MESSAGE)
    }
  }

  private getMeasuresPage = async (sonar_url: string, page: number): Promise<MetricsResponseAPI> => {
    const response = await this.http.get<MetricsResponseAPI>(`${sonar_url}&p=${page}`);

    if (response.status !== 200 || !response.data) {
      throw new Error(`Unexpected response status ${response.status}`)
    }

    return response.data
  }
}
