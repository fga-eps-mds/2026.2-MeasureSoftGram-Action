# MeasureSoftGram no GitLab CI/CD

O componente [`measure.yml`](measure.yml) roda o coletor do MeasureSoftGram em pipelines do GitLab. Ele faz o equivalente à Action do GitHub:

- coleta as métricas do SonarQube/SonarCloud e as métricas de processo do GitLab (issues e pipelines);
- envia as métricas ao MeasureSoftGram-Service;
- em pipelines de Merge Request, publica no MR um comentário com o resultado. Nas execuções seguintes, atualiza esse mesmo comentário.

O job roda em pipelines de Merge Request e na branch padrão do projeto.

## Exemplo

```yaml
# .gitlab-ci.yml do projeto avaliado
stages:
  - test

include:
  - remote: 'https://raw.githubusercontent.com/fga-eps-mds/2026.2-MeasureSoftGram-Action/develop/templates/measure.yml'
    inputs:
      product_name: MeuProduto
      msgram_service_host: https://msgram.exemplo.com
```

Para fixar uma versão, troque `develop` na URL por uma tag.

## Variáveis de CI/CD

Cadastre em **Settings > CI/CD > Variables** do projeto. Marque cada uma como **Masked** e **não** marque **Protected**: variáveis protegidas não chegam aos pipelines de MR.

| Variável | Quando é necessária |
|---|---|
| `MSGRAM_SERVICE_TOKEN` | sempre |
| `GITLAB_TOKEN` | para coletar as métricas do GitLab e para comentar no MR. Use um token de projeto ou pessoal com escopo `api`: o escopo `read_api` não permite criar o comentário |
| `SONAR_TOKEN` | para coletar as métricas do SonarQube |

Se os segredos estiverem em variáveis com outros nomes, informe o **nome** da variável no input (`gitlab_token: $MEU_TOKEN`). Não informe o valor do token: os inputs ficam visíveis no YAML do pipeline.

## Inputs

| Input | Padrão | Descrição |
|---|---|---|
| `product_name` | obrigatório | Nome do produto cadastrado no MeasureSoftGram |
| `msgram_service_host` | obrigatório | URL do MeasureSoftGram-Service |
| `stage` | `test` | Stage em que o job roda |
| `image` | `measuresoftgram/action-gitlab:latest` | Imagem do coletor |
| `msgram_service_token` | `$MSGRAM_SERVICE_TOKEN` | Variável com o token do Service |
| `gitlab_token` | `$GITLAB_TOKEN` | Variável com o token do GitLab |
| `sonar_token` | `$SONAR_TOKEN` | Variável com o token do SonarQube |
| `sonar_host` | `https://sonarcloud.io` | URL do SonarQube |
| `sonar_project_key` | `<namespace>_<projeto>` | Chave do projeto no SonarQube |
| `us_label` | vazio | Label das issues de história de usuário. Vazio considera todas as issues |
| `workflow_name` | vazio | Nome dos pipelines (`workflow:name`) usados no feedback de CI. Vazio considera todos |
| `collect_sonarqube_metrics` | `true` | Coleta as métricas do SonarQube |
| `collect_gitlab_metrics` | `true` | Coleta as métricas de processo do GitLab |

## Pipelines duplicados

Se o projeto roda pipelines de branch e de MR ao mesmo tempo, um push num MR aberto pode criar dois pipelines. Para evitar isso, adicione ao `.gitlab-ci.yml` do projeto:

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH
```
