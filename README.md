# ai-devops-mcp-platform

Platform scope: GitHub Actions failure analysis, CI/CD performance analytics,
Mac runner health monitoring for Android and iOS builds, SonarQube/CodeQL findings
analysis, Azure infrastructure troubleshooting, and automated incident summaries.

## Sample Android pipeline

This repository includes a minimal native Kotlin Android app and a GitHub Actions
workflow in [.github/workflows/android.yml](.github/workflows/android.yml).
The app displays "Hello, Android!" and has three JVM unit tests for greeting logic.

### Build locally

Requirements: JDK 17 and an Android SDK with Android API 36 and Build Tools 35.0.0.
Set `ANDROID_HOME` to your SDK directory, or configure `sdk.dir` in an untracked
`local.properties` file. Android Studio can also open and sync the repository.

Windows PowerShell:

```powershell
.\gradlew.bat --no-daemon lintDebug testDebugUnitTest assembleDebug
```

Linux/macOS:

```sh
./gradlew --no-daemon lintDebug testDebugUnitTest assembleDebug
```

Gradle 8.13 is downloaded by the checked-in wrapper and verified with SHA-256.
The project uses Android Gradle Plugin 8.13.2 and Kotlin 2.1.20, supports Android
6.0/API 23 and newer, and compiles/targets API 36.

### GitHub Actions

The `Android CI` workflow runs on:

- Pushes to `develop` and `feature/**`.
- Pull requests targeting `develop`.
- Manual dispatch from the Actions tab after the workflow is on the default branch.

The Ubuntu 24.04 runner installs Java 17 and the required Android SDK packages, validates
the Gradle wrapper via `setup-gradle`, and runs Android lint, JVM unit tests, and a
debug APK build. Lint errors fail CI; warnings remain visible in the uploaded report.
Version-availability warnings do not force this pinned API 36 sample to adopt a
new Android/Gradle release just to keep building. Test/lint reports are uploaded
even when a build step fails, if reports were generated.

Successful runs publish `android-debug-apk` and `android-quality-reports` artifacts,
retained for seven days. Download the APK from the workflow run's **Artifacts**
section and install it on an emulator/device (for example, `adb install -r app-debug.apk`).
The APK is debug-signed for demonstration, not suitable for Play Store publishing.
No repository secrets, release keystore, emulator, or deployment environment are required.
GitHub-hosted runner usage in private repositories depends on the account's Actions
quota and billing settings.

### Branch flow

```text
feature/<change-name> -> develop
```

Create feature branches from `develop` and open pull requests back into `develop`.
`develop` is the default branch; the remote `main` branch has been removed.
This sample does not automatically merge or push changes between branches.
Configure branch protection/rulesets separately if required; use the
`Build, lint, and unit tests` check as a required check.

## Azure-powered pipeline failure analysis (MCP)

The local stdio MCP server in [mcp-server](mcp-server) exposes two read-only tools:

- `list_failed_runs`: list up to ten recent failed runs in the configured repository.
- `analyze_failed_run`: fetch completed failed jobs (also in an in-progress run) and ask Azure
  OpenAI for root causes, quoted evidence, recommended fixes, and next steps.

Interactive analysis works for existing failures. An optional develop-only automatic
workflow is described below. Neither mode edits code, merges branches, reruns jobs, or executes model-generated
commands. AI output is a suggestion, not proof that a fix works.

### Prerequisites and authentication

- Node.js 22+, GitHub CLI (`gh`), and Azure CLI (`az`) on PATH.
- Run `gh auth login` with read access to this repository and its Actions logs.
- Run `az login` with an account authorized for your Azure OpenAI resource's tenant.
- The account needs **Cognitive Services OpenAI User** at the resource scope (or
  equivalent inference permission). Subscription Contributor alone is not enough.
- Network access to GitHub and the Azure OpenAI endpoint.

No API keys are used or stored. Never paste keys into chat or commit credentials.
If a key is exposed, regenerate it in Azure Portal under **Keys and Endpoint**.

From the repository root:

```powershell
Set-Location .\mcp-server
npm ci
npm test
```

### Use from VS Code

[.vscode/mcp.json](.vscode/mcp.json) registers `pipeline-analysis` using the resource
root endpoint `https://ai-pipeline-analysis-nbs.openai.azure.com/` and deployment
`gpt-4.1-mini`. These are non-secret settings. For another resource, change the
endpoint and deployment in that configuration; do not include a chat-completions path.
The server uses the stable Azure OpenAI `2024-10-21` API for chat completions and
structured output; the deployment's portal URL may instead show a preview API.

Open this repository root as the VS Code workspace. Run **MCP: List Servers** from
the Command Palette, select **pipeline-analysis**, and start it (approve workspace
trust if prompted). Enable its tools in an Agent chat and request:

> List the previous failed Android CI runs. Analyze run 40295005416 using Azure.
> I consent to sending its redacted log excerpts to my Azure OpenAI deployment.

`analyze_failed_run` requires `consentToSendLogs: true`. The host/user must approve
disclosure before calling it. A model response is not allowed to grant that consent.

### Use from PowerShell through the MCP protocol

From the `mcp-server` directory:

```powershell
$env:AZURE_OPENAI_ENDPOINT = "https://ai-pipeline-analysis-nbs.openai.azure.com/"
$env:AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini"
$env:GITHUB_REPOSITORY = "nikhilbs-ciklum/ai-devops-mcp-platform"
npm run analyze -- 40295005416 --allow-azure-log-upload
```

The CLI starts a short-lived MCP server, calls `analyze_failed_run`, prints JSON, and
closes the connection. No long-lived HTTP service is exposed. Omit the consent flag
and no logs are sent. The server itself can also be started with `npm start`, but
it expects an MCP client on stdin; diagnostic output goes to stderr.

### Data handling and troubleshooting

Failed logs are downloaded locally with `gh`; common token, password, authorization,
and credential-in-URL patterns are redacted before excerpt selection. Known token/key
environment values are also removed literally. Up to 24,000 log characters plus
12,000 commit-patch characters are sent to Azure. Error context and line labels are retained;
truncation and excerpt counts are returned. The full raw log is not saved by this
server. Redaction is best effort, **not a guarantee**: logs can contain private code
or other sensitive content, so review the source logs and approve sending them.
Inference incurs Azure usage charges. Treat logs and model output as untrusted.

- `PermissionDenied`/HTTP 401 or 403: check the signed-in account/tenant, resource-scoped
  inference role, and endpoint network restrictions. New RBAC grants can take time
  to propagate; retry after propagation.
- HTTP 404: check the resource endpoint and exact deployment name.
- HTTP 429/408 or transient 5xx: Azure calls retry at most three times. Retry-After
  waits are capped at ten seconds; check quota/service health if attempts are exhausted.
- Network errors/timeouts: at most three attempts, with a 45-second timeout per request.
  Retries can incur additional Azure usage if a response was lost after processing.
- HTTP 401/403/404 and malformed model responses are not automatically retried.
- Missing logs: check GitHub permissions and Actions log retention.
- A tool error is returned explicitly; it is never replaced with a successful-looking
  synthetic analysis.

Run `npm test` for unit and real stdio protocol tests. Tests use mocked GitHub/Azure
responses and do not spend Azure credits or require login. The `MCP server checks`
workflow runs them on pushes and PRs that change the server.

### Windows demo workstation checklist

For an interactive VS Code demo, install **Git**, **Node.js 22 or newer**, **GitHub CLI**,
**Azure CLI**, and **VS Code with Copilot/Agent support**. Restart the terminal after
installation so the tools are on PATH. Android Studio, an Android SDK, and Java are
only needed to build/run the Android app locally, not to analyze GitHub-hosted builds.

From a PowerShell terminal in the repository root:

```powershell
git switch develop
git pull --ff-only origin develop
node --version
gh auth login
az login --tenant 9c8176a3-82ef-4e17-b391-373802f3d8d4
az account set --subscription 64e8b0c5-e7ed-450d-a62d-8dd37014c788
Set-Location .\mcp-server
npm ci
npm test
```

These commands assume the MCP PR has been merged into `develop`; until then use the
PR feature branch. Start the server through **MCP: List Servers** for a chat demo,
or run the documented CLI command for a historical failed run. No API key is needed.

### Optional automatic analysis of failed develop builds

[Android CI](.github/workflows/android.yml) calls the reusable
[AI failure analysis](.github/workflows/ai-failure-analysis.yml) workflow as the
`ai-failure-analysis` job in the **same run**. Its condition is
`always() && !cancelled() && needs.build.result == 'failure'`. The existing `build`
steps are unchanged. Successful, skipped, and cancelled builds skip analysis.
The failed build stays failed; no `continue-on-error` masks it.

The reusable YAML no longer has a `workflow_run` trigger. Only enabled push/manual
builds on `develop` use Azure, matching existing OIDC trust. PRs (including forks),
other refs, and disabled analysis produce a skip note without checkout, MCP, GitHub
API queries, or Azure calls in the analysis workflow. OIDC permission is limited
to the caller and analyzer, not the build.

The Node client starts the existing stdio MCP server and calls `analyze_failed_run`
with the current run ID. No new tools, Python client, hosting, or secrets are added.
In-progress workflows are accepted only when completed failed jobs exist. The server
validates API metadata, queries paginated jobs and the individual job-log API, not
unfinished run-level logs. Log downloads retry three times, ten seconds apart. This path is unit-tested; live
API availability during an in-progress run needs approval-gated GitHub verification.

Only timestamp-selected failing-step windows are excerpted (24,000 total characters),
plus redacted commit patches (12,000 characters). Files named in logs are preferred;
otherwise up to five candidate changed files are included with an explicit limitation.
The diff is the head commit's first-parent patch, not the entire PR. Missing/binary
patches, truncation, and diff API failure are reported as missing evidence. Full source
files and full job logs are not sent. Missing/unidentifiable step windows, failed
downloads, and oversized logs are explicitly listed as missing evidence. Other usable
jobs and diff evidence are retained; a metadata-only diagnosis is marked low confidence.
Original job-log line numbers and timestamps are retained, including the complete
final second of a failed step (the step API has second-level precision).

The report includes run ID, failed job/step, summary, probable causes, quoted evidence,
run URL, file/line or unavailable, fixes, next steps, confidence with its reason,
and missing evidence. Model quotes not found exactly in the supplied log excerpt
are removed and confidence is lowered. Exact quoting verifies the source of a
statement, not the truth of the model's proposed root cause.
Logs/diffs are untrusted data, never instructions; output is inert indented text.
A separate fallback step writes **AI analysis unavailable** with the failed stage,
even when no report file exists.

The stable Azure API, `gpt-4.1-mini` default, temperature `0`, and Azure CLI/OIDC
authentication are preserved. No reasoning-effort parameter is sent. Actions remain
version-tagged, matching this repository's standard.

The feature is **off by default**. You do not need to comment out YAML to hide it.
Use **Settings > Secrets and variables > Actions > Variables**:

| Repository variable | Value |
| --- | --- |
| `AI_FAILURE_ANALYSIS_ENABLED` | `true` for the demo; `false` otherwise |
| `AZURE_OPENAI_ENDPOINT` | `https://ai-pipeline-analysis-nbs.openai.azure.com/` |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4.1-mini` |
| `AZURE_TENANT_ID` | `9c8176a3-82ef-4e17-b391-373802f3d8d4` |
| `AZURE_SUBSCRIPTION_ID` | `64e8b0c5-e7ed-450d-a62d-8dd37014c788` |
| `AZURE_CLIENT_ID` | Client ID of the dedicated federated application below |
| `AI_MAX_LOG_CHARS` (optional) | `1000` to `24000`; default `24000` |
| `AI_MAX_DIFF_CHARS` (optional) | `1000` to `12000`; default `12000` |

The evidence-limit variables can only reduce the hard caps. Invalid values fail
explicitly before any evidence request. `gpt-4.1-mini` is selected by deployment
name; the deployment's model version (expected `2025-04-14`) is managed in Azure and
must be checked there. Local tests do not verify resource reachability or model version.

Enabling the variable is the repository administrator's consent to send bounded,
best-effort redacted failed-job excerpts to this Azure deployment. Review what your
logs contain before enabling it. Azure charges apply. To disable future analysis:

```powershell
gh variable set AI_FAILURE_ANALYSIS_ENABLED --body false
```

This does not cancel an analysis already running. Disabled or ineligible events can
appear as skipped workflow jobs; no Azure call is made.

#### One-time Azure OIDC setup (administrator)

GitHub-hosted runners cannot use the Windows user's `az login` session. Create a
dedicated Entra application with a service principal and a federated credential;
do **not** create a client secret. These commands change Azure resources, so an
authorized administrator should run them once after review. Entra application
creation and role assignment permissions are required. Record the created app ID
for future maintenance; do not rerun blindly if the application already exists.

```powershell
$clientId = az ad app create --display-name "ai-devops-pipeline-analysis" --query appId -o tsv
if ($LASTEXITCODE -ne 0) { throw "Application creation failed" }
$principalId = az ad sp create --id $clientId --query id -o tsv
if ($LASTEXITCODE -ne 0) { throw "Service principal creation failed" }

$federation = @{
    name = "github-develop"
    issuer = "https://token.actions.githubusercontent.com"
    subject = "repo:nikhilbs-ciklum@182882634/ai-devops-mcp-platform@1434118245:ref:refs/heads/develop"
    audiences = @("api://AzureADTokenExchange")
} | ConvertTo-Json
$credentialFile = Join-Path $env:TEMP "ai-pipeline-federation.json"
$federation | Set-Content -Path $credentialFile -Encoding ascii
az ad app federated-credential create --id $clientId --parameters "@$credentialFile"
if ($LASTEXITCODE -ne 0) { throw "Federated credential creation failed" }
Remove-Item -LiteralPath $credentialFile

$scope = "/subscriptions/64e8b0c5-e7ed-450d-a62d-8dd37014c788/resourceGroups/ITSD-178412/providers/Microsoft.CognitiveServices/accounts/ai-pipeline-analysis-nbs"
az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role "Cognitive Services OpenAI User" --scope $scope
if ($LASTEXITCODE -ne 0) { throw "Inference role assignment failed" }

gh variable set AZURE_CLIENT_ID --body $clientId
gh variable set AZURE_TENANT_ID --body "9c8176a3-82ef-4e17-b391-373802f3d8d4"
gh variable set AZURE_SUBSCRIPTION_ID --body "64e8b0c5-e7ed-450d-a62d-8dd37014c788"
gh variable set AZURE_OPENAI_ENDPOINT --body "https://ai-pipeline-analysis-nbs.openai.azure.com/"
gh variable set AZURE_OPENAI_DEPLOYMENT --body "gpt-4.1-mini"
gh variable set AI_FAILURE_ANALYSIS_ENABLED --body false
```

The subject is deliberately limited to `develop`. Do not change it to trust PRs or
arbitrary branches. The identity receives resource-scoped inference permission, not
subscription Contributor/Owner. `azure/login` allows login without subscription
visibility because only inference access is required. Wait for role propagation
before enabling the feature.

This repository's observed GitHub OIDC subject includes immutable owner/repository
IDs, as shown above. For another repository, match the exact `subject claim` printed
by `azure/login`; older configurations can use a name-only subject. A mismatch causes
`AADSTS700213`. Never broaden the trust rule to work around a subject mismatch.

The configured demo application client ID is `22bbcaf1-3c92-416d-9825-d13beb9fc461`.
It has no client secret and is restricted to this repository's `develop` subject.

#### Presenting the automatic demo

1. Merge the PR and complete OIDC configuration above.
2. Enable the variable: `gh variable set AI_FAILURE_ANALYSIS_ENABLED --body true`.
3. Let an actual Android build fail on `develop` (push or manual run). Do not
   deliberately commit a broken build to shared `develop` without team approval.
   For a safe no-change demo, use the historical-run interactive MCP command instead.
4. Open the same **Actions > Android CI** run and select `ai-failure-analysis / analyze`.
5. Show the **Summary** diagnosis/evidence and download the
   `ai-failure-analysis-<run-id>` artifact containing `analysis.md` and `analysis.json`.
6. Set the enable variable back to `false`.

The original Android run stays failed. An analyzer/configuration failure also fails
the analysis job explicitly; it does not produce a success-shaped report.
Reports are retained for seven days and may contain private log excerpts/model
output, so limit Actions access accordingly. This workflow does not analyze old runs
merely because the variable was enabled.

#### Local and approval-gated end-to-end verification

Run `npm test` from `mcp-server` and actionlint against the workflow YAML files.
Tests cover actual workflow gate expressions, MCP stdio, malformed GitHub/model
responses, evidence limits, redaction, partial evidence, retries, and safe reports.
The actual fallback Bash script is executed locally when Bash is installed (Git
Bash on Windows); otherwise that shell test is explicitly skipped and runs on Linux CI.
Tests do not call Azure or rerun pipelines.

After reviewing and approving publication and pipeline execution:

1. **Green:** run Android CI on `develop`; `ai-failure-analysis` must be skipped.
   No MCP process or Azure login should execute.
2. **Failure:** enable the variable and introduce an approved temporary Kotlin test
   failure. The build fails while `ai-failure-analysis / analyze` runs in the same
   run ID. Check summary, evidence, and JSON/Markdown artifacts. Confirm completed
   job logs can be fetched while the overall run is still in progress.
3. **Analyzer failure:** test an approved invalid deployment/configuration. The
   fallback note must identify the failed stage, and the build must remain failed.
4. **Fork PR:** a failed fork build gets only a skip note; no Azure login or evidence
   API queries should execute in the analysis workflow.
5. Restore intentional errors and configuration, verify green, then disable the
   switch. These steps require approval; they are not part of local validation.

No API-key secrets are required by this OIDC integration. The repository variables
above retain their exact names. Do not broaden Azure trust to PRs.

The ten-minute job timeout and eight-minute MCP timeout bound the overall attempt.
An infrastructure failure, runner termination, or cancellation may prevent the final
fallback step from executing. Highly unusual runs with many failed jobs/slow APIs can
hit these bounds. Only the first five failed jobs are examined; any omission is listed
as missing evidence. Artifacts and summaries can still contain private code excerpts.
Best-effort redaction does not guarantee removal of every secret format.

#### Historical post-run demo (before same-run conversion)

The approved temporary failure changed `createsGreeting` to expect `Hello, Demo!`
while the app returned `Hello, Android!`. Full unit-test exception logging exposes
both assertion values to the analyzer without changing test pass/fail behavior.

- [Intentional failed Android run](https://github.com/nikhilbs-ciklum/ai-devops-mcp-platform/actions/runs/40304250076)
- [Automatically triggered successful AI analysis](https://github.com/nikhilbs-ciklum/ai-devops-mcp-platform/actions/runs/40304449995)

Open the analysis run's **Summary** to see the AI root cause, evidence, and suggested
fixes. Under the `analyze` job, expand **Analyze failed Android run through MCP** to
see the JSON response. The artifact `ai-failure-analysis-40304250076` contains both
report formats (retained seven days).

The model identified the expected-versus-actual mismatch. A human restored the
original test expectation; remediation was not performed by the model. Automatic
analysis was disabled after the demo using the repository variable. The Azure
federated identity remains configured so the workflow can be enabled for later demos.
