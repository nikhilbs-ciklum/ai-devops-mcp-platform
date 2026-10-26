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
- `analyze_failed_run`: fetch a completed failed run's failed-job logs and ask Azure
  OpenAI for root causes, quoted evidence, recommended fixes, and next steps.

This is interactive analysis of existing failures, not an automatic failure-triggered
workflow. It never edits code, merges branches, reruns jobs, or executes model-generated
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
and credential-in-URL patterns are redacted before excerpt selection. Only up to
24,000 characters are sent to Azure. Error context and log line labels are retained;
truncation and excerpt counts are returned. The full raw log is not saved by this
server. Redaction is best effort, **not a guarantee**: logs can contain private code
or other sensitive content, so review the source logs and approve sending them.
Inference incurs Azure usage charges. Treat logs and model output as untrusted.

- `PermissionDenied`/HTTP 401 or 403: check the signed-in account/tenant, resource-scoped
  inference role, and endpoint network restrictions. New RBAC grants can take time
  to propagate; retry after propagation.
- HTTP 404: check the resource endpoint and exact deployment name.
- HTTP 429: check model quota and retry later; automatic retries are not performed.
- Missing logs: check GitHub permissions and Actions log retention.
- A tool error is returned explicitly; it is never replaced with a successful-looking
  synthetic analysis.

Run `npm test` for unit and real stdio protocol tests. Tests use mocked GitHub/Azure
responses and do not spend Azure credits or require login. The `MCP server checks`
workflow runs them on pushes and PRs that change the server.
