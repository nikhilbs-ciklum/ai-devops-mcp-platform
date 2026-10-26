# ai-devops-mcp-platform

Platform scope: GitHub Actions failure analysis, CI/CD performance analytics,
Mac runner health monitoring for Android and iOS builds, SonarQube/CodeQL findings
analysis, Azure infrastructure troubleshooting, and automated incident summaries.

## Sample Android pipeline

This repository includes a minimal native Kotlin Android app and a GitHub Actions
workflow in [.github/workflows/android.yml](.github/workflows/android.yml).
The app displays "Hello, Android!" and has three JVM unit tests for greeting logic.

### Build locally

Requirements: JDK 17 and an Android SDK with Android API 35 and Build Tools 35.0.0.
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

Gradle 8.11.1 is downloaded by the checked-in wrapper and verified with SHA-256.
The project uses Android Gradle Plugin 8.9.2 and Kotlin 2.1.20, supports Android
6.0/API 23 and newer, and compiles/targets API 35.

### GitHub Actions

The `Android CI` workflow runs on:

- Pushes to `main`, `develop`, and `feature/**`.
- Pull requests targeting `main` or `develop`.
- Manual dispatch from the Actions tab after the workflow is on the default branch.

The Ubuntu 24.04 runner installs Java 17 and the required Android SDK packages, validates
the Gradle wrapper via `setup-gradle`, and runs Android lint, JVM unit tests, and a
debug APK build. Lint warnings and errors fail CI. Test/lint reports are uploaded
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
feature/android-pipeline -> develop -> main
```

Create feature branches from `develop` and open pull requests back into `develop`.
After validation, open a separate promotion PR from `develop` to `main`.
This sample does not automatically merge or push changes between branches.
Configure branch protection/rulesets separately if required; use the
`Build, lint, and unit tests` check as a required check.
