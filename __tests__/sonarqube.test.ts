import axios from 'axios';
import Sonarqube from '../src/sonarqube';
import { Info } from '../src/utils';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Sonarqube', () => {
  beforeEach(() => {
    // Reset calls and queued implementations, so a response left unused by one test does not leak into the next:
    mockedAxios.create.mockReset();
    mockedAxios.get.mockReset();
  });

  test('Constructor should use provided host if available', () => {
    const info: Info = {
      host: 'http://my-sonarqube-instance.com',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
      token: ''
    };

    const sonarqube = new Sonarqube(info);

    expect(sonarqube.host).toBe(info.host);
  });

  test('Constructor should use default host if no host provided', () => {
    const info: Info = {
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
      host: '',
      token: ''
    };

    const sonarqube = new Sonarqube(info);

    expect(sonarqube.host).toBe('https://sonarcloud.io');
  });

  test('Constructor should initialize correctly with given data', () => {
    const info: Info = {
      host: 'http://localhost:9000',
      token: '123456',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
    };

    const tokenb64 = Buffer.from(`${info.token}:`).toString('base64');

    new Sonarqube(info);

    expect(mockedAxios.create).toHaveBeenCalledTimes(1);
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: info.host,
      timeout: 10000,
      headers: {
        Authorization: `Basic ${tokenb64}`,
      },
    });
  });

  test('Constructor should initialize correctly without Authorization header if no token given', () => {
    const info: Info = {
      host: 'http://localhost:9000',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
      token: ''
    };
  
    new Sonarqube(info);
  
    expect(mockedAxios.create).toHaveBeenCalledTimes(1);
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: info.host,
        timeout: 10000,
      })
    );
    const callArg = mockedAxios.create.mock.calls[0]?.[0];
    if (!info.token) {
      if (callArg?.headers && 'Authorization' in callArg.headers) {
        expect(callArg.headers.Authorization).toBe("");
      } else {
        fail("Authorization header not found");
      }
    }
  });
   

  test('getMeasures should make a correct axios call', async () => {
    const info: Info = {
      host: 'http://localhost:9000',
      token: '123456',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
    };

    const pageSize = 500;
    const sonar_url = `/api/measures/component_tree?component=${info.project.sonarProjectKey}&metricKeys=files,sqale_debt_ratio,functions,complexity,comment_lines_density,duplicated_lines_density,coverage,ncloc,tests,test_errors,test_failures,test_execution_time,security_rating,test_success_density,reliability_rating&ps=${pageSize}&p=1`;

    const measuresResponse = { 
      data: { 
        paging: {
          pageIndex: 1,
          pageSize: 500,
          total: 0
        },
        baseComponent: {},
        components: [],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    };

    mockedAxios.get.mockImplementationOnce(async (url, options) => {
      console.log(`URL: ${url}`);
      console.log(`Options: ${JSON.stringify(options)}`);
      if (url === sonar_url) {
        return Promise.resolve(measuresResponse);
      }
      return Promise.reject('Unexpected URL or options');
    });

    mockedAxios.create.mockImplementationOnce(() => mockedAxios);

    const sonarqube = new Sonarqube(info);
    
    try {
      const measures = await sonarqube.getMeasures({ pageSize, pullRequestNumber: null });
      expect(measures).toEqual(measuresResponse.data);
      expect(mockedAxios.get).toHaveBeenCalledWith(sonar_url);
    } catch (error) {
      console.log('Error in test: ', error);
      throw error;
    }
  });

  test('getMeasures should handle axios errors', async () => {
    const info: Info = {
      host: 'http://localhost:9000',
      token: '123456',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
    };

    mockedAxios.get.mockImplementationOnce(async () => {
      return Promise.reject(new Error('API call failed'));
    });

    mockedAxios.create.mockImplementationOnce(() => mockedAxios);

    const sonarqube = new Sonarqube(info);
    const pageSize = 500;
    await expect(sonarqube.getMeasures({ pageSize, pullRequestNumber: null })).rejects.toThrow('Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.');
  });

  test('getMeasures should handle non-200 status codes', async () => {
    const info: Info = {
      host: 'http://localhost:9000',
      token: '123456',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
    };
  
    mockedAxios.get.mockImplementationOnce(async () => {
      return Promise.resolve({
        status: 400, // Non-200 status
        data: null, // No data
      });
    });
  
    mockedAxios.create.mockImplementationOnce(() => mockedAxios);
  
    const sonarqube = new Sonarqube(info);
    const pageSize = 500;
    await expect(sonarqube.getMeasures({ pageSize, pullRequestNumber: 3 })).rejects.toThrow('Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.');
  });

  describe('getMeasures pagination', () => {
    const info: Info = {
      host: 'http://localhost:9000',
      token: '123456',
      project: {
        sonarProjectKey: 'sonarProjectKey',
      },
    };
    const pageSize = 2;
    const baseUrl = `/api/measures/component_tree?component=${info.project.sonarProjectKey}&metricKeys=files,sqale_debt_ratio,functions,complexity,comment_lines_density,duplicated_lines_density,coverage,ncloc,tests,test_errors,test_failures,test_execution_time,security_rating,test_success_density,reliability_rating&ps=${pageSize}`;
    const baseComponent = { id: 'base', key: 'sonarProjectKey', name: 'project', qualifier: 'TRK', measures: [] };
    const component = (key: string) => ({
      id: key, key, name: key, qualifier: 'FIL', path: key, language: 'ts', measures: [],
    });
    const pageResponse = (pageIndex: number, components: unknown[], total = 3) => ({
      data: {
        paging: { pageIndex, pageSize, total },
        baseComponent,
        components,
      },
      status: 200,
    });

    test('should fetch every page and merge the components into a single response', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')]))
        .mockResolvedValueOnce(pageResponse(2, [component('c.ts')]));
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);
      const measures = await sonarqube.getMeasures({ pageSize, pullRequestNumber: null });

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(mockedAxios.get).toHaveBeenNthCalledWith(1, `${baseUrl}&p=1`);
      expect(mockedAxios.get).toHaveBeenNthCalledWith(2, `${baseUrl}&p=2`);
      expect(measures).toEqual({
        paging: { pageIndex: 1, pageSize, total: 3 },
        baseComponent,
        components: [component('a.ts'), component('b.ts'), component('c.ts')],
      });
    });

    test('should keep the pullRequest filter on every page', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')]))
        .mockResolvedValueOnce(pageResponse(2, [component('c.ts')]));
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);
      await sonarqube.getMeasures({ pageSize, pullRequestNumber: 42 });

      expect(mockedAxios.get).toHaveBeenNthCalledWith(1, `${baseUrl}&pullRequest=42&p=1`);
      expect(mockedAxios.get).toHaveBeenNthCalledWith(2, `${baseUrl}&pullRequest=42&p=2`);
    });

    test('should throw the same error when a later page fails, without returning partial data', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')]))
        .mockRejectedValueOnce(new Error('API call failed'));
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);

      await expect(sonarqube.getMeasures({ pageSize, pullRequestNumber: null })).rejects.toThrow('Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.');
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    test('should throw the same error when a later page returns a non-200 status', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')]))
        .mockResolvedValueOnce({ status: 500, data: null });
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);

      await expect(sonarqube.getMeasures({ pageSize, pullRequestNumber: null })).rejects.toThrow('Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.');
    });

    test('should not request an extra page when total is an exact multiple of the page size', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')], 4))
        .mockResolvedValueOnce(pageResponse(2, [component('c.ts'), component('d.ts')], 4));
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);
      const measures = await sonarqube.getMeasures({ pageSize, pullRequestNumber: null });

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(measures.components).toHaveLength(4);
    });

    test('should fetch a single page when paging has an invalid page size', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { paging: { pageIndex: 1, pageSize: 0, total: 3 }, baseComponent, components: [component('a.ts')] },
        status: 200,
      });
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);
      const measures = await sonarqube.getMeasures({ pageSize, pullRequestNumber: null });

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(measures.components).toEqual([component('a.ts')]);
    });

    test('should fetch a single page when paging is missing', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { baseComponent, components: [component('a.ts')] },
        status: 200,
      });
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);
      const measures = await sonarqube.getMeasures({ pageSize, pullRequestNumber: null });

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(measures.components).toEqual([component('a.ts')]);
    });

    test('should log which page failed and why', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockedAxios.get
        .mockResolvedValueOnce(pageResponse(1, [component('a.ts'), component('b.ts')]))
        .mockResolvedValueOnce({ status: 503, data: null });
      mockedAxios.create.mockImplementationOnce(() => mockedAxios);

      const sonarqube = new Sonarqube(info);

      await expect(sonarqube.getMeasures({ pageSize, pullRequestNumber: null })).rejects.toThrow('Error getting project measures from SonarQube. Please make sure you provided the host and token inputs.');
      expect(consoleError).toHaveBeenCalledWith('Error getting SonarQube measures page 2: Unexpected response status 503');

      consoleError.mockRestore();
    });
  });
  
});
