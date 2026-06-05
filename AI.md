# AI Instructions

Auto-generated from a shared NitroPush skills repo. Any AI coding tool that supports loading context from a file can use this.

Apply the section whose **When to apply** description matches your current task. If multiple sections match, apply all of them.

---

## nitropush-cli

> **When to apply:** Use when the user asks about the NitroPush CLI (`nitropush` binary), wants to script releases/uploads/rollouts, asks about CLI auth/login/whoami, or is editing files under `packages/cli/`. Covers every subcommand, required flags, config file location, env vars, and CI patterns.

The `nitropush` binary is a Commander.js CLI that drives the NitroPush admin API. Source: [packages/cli/](../../packages/cli/). Binary entry: [packages/cli/src/index.ts](../../packages/cli/src/index.ts) (compiled to `dist/index.js`, registered as `bin.nitropush` in [packages/cli/package.json](../../packages/cli/package.json)).

## Mental model

The CLI is a thin wrapper over the admin API at `serverUrl` (default `https://app.nitropush.cloud`). It does **not** talk to S3 directly — uploads go through the admin API which returns presigned URLs. Three things to remember:

1. **Auth state** lives in `~/.nitropush/config.json` — `{ serverUrl, token?, orgId?, userId? }`. Token is base64url-encoded JSON, decodable offline (this is why `whoami --offline` works).
2. **All subcommands take explicit flags** — never positional args. This makes the CLI safe to script.
3. **`release upload` is the canonical deploy command** — it auto-detects Expo (looks for `metadata.json`) vs CodePush (looks for `.hbc`/`.jsbundle`), computes SHA-256, and uploads in one request.

## Auth

```bash
# Interactive (opens browser, OAuth loopback like `gh auth login`)
nitropush login
nitropush login --server https://my-self-hosted.example.com

# Non-interactive (CI)
nitropush login --token "$NITROPUSH_API_TOKEN" --org <orgId> --user <userId>

# Inspect (exit 1 if not authed)
nitropush whoami
nitropush whoami --json     # machine-readable
nitropush whoami --offline  # decode local token only, no server call

# Forget
nitropush logout
nitropush logout --keep-server  # local wipe only, no server revoke
```

**Login timeout:** browser flow gives up after 5 min (`LOGIN_TIMEOUT_MS` in `packages/cli/src/commands/login.ts`).

**Env var overrides** (read at runtime, win over config file):
- `NITROPUSH_SERVER_URL` — server URL
- `CODEPUSH_SERVER_URL` — fallback server URL (legacy)
- `CODEPUSH_API_TOKEN` — token override

**Scriptable auth check:**
```bash
nitropush whoami > /dev/null 2>&1 || { echo "Not logged in"; exit 1; }
```

## Resource hierarchy

```
Org → App → Environment (test|stage|prod) → Release
                       ↘ EnvironmentKey (rotatable)
```

Create top-down. Every command after `login` needs at minimum the `orgId`; `app` and `release` commands need their respective parent IDs.

## Command reference

### Org
```bash
nitropush org create --slug acme --name "ACME Inc"
```

### App
```bash
nitropush app create --org <orgId> --name "MyApp" --bundle-id com.acme.app
nitropush app list   --org <orgId>
```

### Environment
```bash
nitropush env create --app <appId> --name prod
```

### Environment key (rotation)
```bash
nitropush key rotate \
  --env <environmentId> \
  --key-id <keyId> \
  --public-key <publicKey> \
  --secret-hash <secretHash>

nitropush key validate --env <environmentId> --key-id <keyId>
```

### Release — the workflow you'll use 95% of the time

```bash
# Auto-detect + upload (preferred)
nitropush release upload \
  --project <projectId> \
  --environment prod \
  --app-version 1.0.0 \           # native binary version, or '*' for universal
  --label 1.0.5 \                 # release label
  --bundle-path ./dist-ios \      # Expo: dist-<platform>/ dir | CodePush: .hbc / .jsbundle
  [--platforms ios,android] \     # defaults to project's configured platforms
  [--assets-dir ./assets] \       # CodePush only
  [--kind expo|codepush] \        # override auto-detection
  [--signing-key <path>]          # path to ECDSA P-256 private key PEM; required when project has a bundle-signing public key configured
```

Auto-detection logic: `metadata.json` present → expo, otherwise walks for `.hbc`/`.jsbundle` → codepush.

**Bundle signing (`--signing-key`):** Pass a file path to a PEM-encoded ECDSA P-256 private key. The CLI signs the bundle before upload; the server verifies the signature against the public key stored in project settings. Required when the project has bundle-signing enabled — upload is rejected without it. **Never pass the PEM content directly as a flag value** — write it to a temp file first to avoid leaking it in process listings.

```bash
# Other release commands
nitropush release list     --env <envId> --platform ios --runtime-version 1.0.0
nitropush release rollout  --release-id <id> --percentage 50          # integer 0-100
nitropush release promote  --release-id <id>                          # to next env
nitropush release create   --env <envId> --platform ios --runtime-version 1.0.0 \
                           --label 1.0.5 --bundle-key <s3-key> --checksum <sha256> \
                           [--sourcemap-key <s3-key>]
nitropush release bundle-create --output ./bundle-out --platform ios --runtime-version 1.0.0
```

### Interactive
```bash
nitropush interactive   # alias: nitropush wizard
```
Menu-driven flow for users who don't want to remember flags. Not for scripting.

## Output mode (important for agents)

- **Default:** colored TTY (chalk + ora spinners + figlet banner). Not safe to parse.
- **JSON:** **only `whoami --json`** currently emits structured JSON. Other commands print pretty text. If you need to capture state for scripts, prefer `whoami --json` + the admin API directly over scraping CLI output.
- **Errors:** exit code 1, written to stderr.
- **`release upload`:** prints SHA-256, byte size, asset count after a successful upload — useful for logs but not stable to parse.

## CI patterns

```yaml
# GitHub Actions — basic upload
- name: Authenticate
  run: nitropush login --token "$NITROPUSH_API_TOKEN" --org "$NL_ORG" --user "$NL_USER"
  env:
    NITROPUSH_API_TOKEN: ${{ secrets.NITROPUSH_API_TOKEN }}

- name: Upload release
  run: |
    nitropush release upload \
      --project "$PROJECT_ID" \
      --environment prod \
      --app-version "${{ github.ref_name }}" \
      --label "${{ github.sha }}" \
      --bundle-path ./dist-ios
```

```yaml
# GitHub Actions — upload with bundle signing
# Store the ECDSA P-256 PEM as a repository/org secret named NITROPUSH_BUNDLE_SIGNING_KEY.
- name: Upload release (signed)
  env:
    NITROPUSH_BUNDLE_SIGNING_KEY_PEM: ${{ secrets.NITROPUSH_BUNDLE_SIGNING_KEY }}
  run: |
    # Write PEM to a temp file — never pass PEM content as a flag value (process-listing leak).
    SIGNING_KEY_FILE="$(mktemp)"
    printf '%s' "${NITROPUSH_BUNDLE_SIGNING_KEY_PEM}" > "${SIGNING_KEY_FILE}"

    nitropush release upload \
      --project "$PROJECT_ID" \
      --environment prod \
      --app-version "${{ github.ref_name }}" \
      --label "${{ github.sha }}" \
      --bundle-path ./dist-ios \
      --signing-key "${SIGNING_KEY_FILE}"

    rm -f "${SIGNING_KEY_FILE}"
```

`--token` skips the browser flow entirely — required in CI.

## Things to NOT do

- Don't invent commands. The full set is: `login`, `logout`, `whoami`, `org create`, `app create`, `app list`, `env create`, `key rotate`, `key validate`, `release create|upload|promote|list|rollout|bundle-create`, `interactive`/`wizard`. That's it.
- Don't assume `--json` works on commands other than `whoami`.
- Don't write `nitropush config set ...` — there is no `config` command. Edit `~/.nitropush/config.json` directly or use env vars.
- Don't expect positional args anywhere — every value is a named flag.
- Don't use `nitropush release create` for normal deploys — it requires you to already have an S3 key + checksum. Use `release upload` instead, which handles upload + checksum + create in one step.

---

## nitropush-integration

> **When to apply:** Use when a user wants to ADD/INTEGRATE NitroPush OTA updates into their app for the first time ("integrate nitropush", "set up nitropush", "add OTA updates", "onboard my app"). This is the end-to-end onboarding playbook — it sequences account setup, native wiring, and JS wiring, and delegates the details to the nitropush-cli, nitropush-rn-native, and nitropush-rn-js skills. NOT for questions about an already-integrated app.

This is the **interactive setup flow** an agent runs when a user says they want to
integrate NitroPush. It is a sequencer, not a reference — each step links to the
skill that owns the detail (`nitropush-cli`, `nitropush-rn-native`,
`nitropush-rn-js`). Follow the steps in order. Do not skip any gate.

## Marker legend

| Marker | Meaning |
|--------|---------|
| 🧑 **ASK** | You MUST ask the user and wait for an answer before continuing. |
| ✋ **NUDGE** | The user has to do this themselves (browser, secrets, device build). Surface clear instructions and pause; you cannot do it for them. |
| 🤖 **AUTO** | You do this — edit files / run codegen — then show the diff. |

## Step 0 — Detect project context (NO QUESTIONS if obvious)

### 0a — Wrong directory guard (check FIRST, before anything else)

Read the directory you are operating in. If you see **any** of these:
- a `nitro.json` file
- a `.podspec` file
- no `App.tsx`, `App.js`, or `src/App.*` entry point

…you are inside the **NitroPush library package**, not a user app. **Stop immediately** and tell the user:

> "This looks like the NitroPush library directory, not your app. Please open a terminal in your Expo or React Native app's root folder and ask me again from there."

Do not attempt any integration steps until they confirm you are in the correct directory.

### 0b — Auto-detect Expo vs bare React Native

Read `package.json` and `app.json` (if present) before asking anything.

**Infer silently and proceed** using these rules:

| Signal | Conclusion |
|--------|------------|
| `"expo"` in `package.json` dependencies **and** `"expo"` key in `app.json` | **Expo** |
| `ios/AppDelegate.swift` (or `.m`) exists but no `expo` dep | **Bare RN** |
| `app.json` present but no `expo` key, no `ios/AppDelegate.*` | **Ambiguous** |

- If **Expo**: state your conclusion out loud ("I can see this is an Expo project — I'll use the config plugin path") and continue to Step 1. Do not ask.
- If **bare RN**: state your conclusion and continue. Do not ask.
- If **ambiguous only**: 🧑 **ASK** once. Never ask when the answer is obvious.

Record the result as **PROJECT_KIND**.

## Step 1 — 🧑 ASK: Dashboard project already set up? (MANDATORY GATE)

## Step 1 — 🧑 ASK: Dashboard project already set up? (MANDATORY GATE)

**Before creating anything, ask:**

> "Do you already have a NitroPush project set up in the dashboard
> (app created + environment created + deployment key copied)?"

### If YES — project already exists

Skip app/environment creation. Instead:

1. ✋ **NUDGE:** ask the user to paste their **App ID** and **deployment key** from
   the dashboard (or from `nitropush app list` output). Store both for later steps.
   Do NOT guess or invent these values.
2. Run `nitropush whoami --json` yourself to confirm auth and capture `orgId`.
3. Jump directly to **Step 2 — Signing key**.

### If NO — need to create a project

The device needs three values to talk to NitroPush: `deploymentKey`
(the environment key), `serverUrl`, `storageBaseUrl`. To produce them the
user must have an org, an app, and an environment. Drive this with the CLI —
see the **nitropush-cli** skill for exact flags.

1. ✋ **NUDGE: login.** `nitropush login` opens a browser OAuth loopback — you
   cannot complete it headless. Tell the user to run it and come back. (CI/token
   path: `nitropush login --token … --org … --user …` — only if they explicitly
   want non-interactive.) Then run `nitropush whoami --json` yourself to confirm
   auth and capture `orgId`.
2. 🤖 **AUTO: create the app.**
   `nitropush app create --org <orgId> --name "<AppName>"` —
   🧑 **ASK** for the app display name if you can't read it confidently from
   `app.json` / native projects. Capture the returned **App ID**.
3. 🤖 **AUTO: create environment(s).** `nitropush env create --app <appId> --name prod`
   (offer `test`/`stage` too — 🧑 **ASK** which environments they want; default
   to just `prod` if unsure).
4. ✋ **NUDGE: capture the deployment key.** The `deploymentKey` is printed in the
   `env create` output. Have the user copy it now — it is not recoverable from the
   CLI later. Do **not** hardcode a guessed key.

Resource order is strict: **Org → App → Environment**. Create top-down.

## Step 2 — 🧑 ASK: Bundle signing opt-in (MANDATORY GATE)

Bundle signing lets the SDK verify that every OTA bundle was produced by you and
has not been tampered with. It is opt-in and **strongly recommended for production**.

**Ask the user:**

> "Do you want to enable **bundle signing**? (Recommended for production)
>
> This generates an ECDSA P-256 keypair. The public key is registered with
> NitroPush; the private key stays with you and is used to sign every upload.
> The SDK verifies the signature before installing any update — a tampered
> bundle is rejected before it touches the device."

### If YES — enable signing

1. 🤖 **AUTO:** run the generate command (requires the App ID from Step 1):
   ```bash
   nitropush app signing-key generate --app <appId> --out ./nitropush-signing.pem
   ```
   This generates the keypair, registers the public key with NitroPush, and
   writes the private key PEM to `./nitropush-signing.pem`.

2. ✋ **NUDGE: secure the private key.** Tell the user to do ALL of the following:
   - Add `nitropush-signing.pem` to `.gitignore` immediately — never commit it.
   - For CI: store the PEM file's content as a repository secret (e.g.
     `NITROPUSH_BUNDLE_SIGNING_KEY`) and write it to a temp file at upload time:
     ```bash
     KEY_FILE="$(mktemp)"
     printf '%s' "$NITROPUSH_BUNDLE_SIGNING_KEY" > "$KEY_FILE"
     nitropush release upload ... --signing-key "$KEY_FILE"
     rm -f "$KEY_FILE"
     ```
   - For local dev: keep the PEM file in the project root (gitignored) and pass
     `--signing-key ./nitropush-signing.pem` on every `release upload`.

3. Record that signing is enabled. Every `release upload` command you suggest
   from this point MUST include `--signing-key <path>`.

### If NO — skip signing

Signing is off. OTA bundles are still encrypted in transit (TLS) but not
signature-verified on device. You may mention this tradeoff once, then move on.
Do not add `--signing-key` to any future commands.

## Step 3 — Native wiring (uses `nitropush-rn-native` skill)

Branch on **PROJECT_KIND**. Full detail (file contents, the Xcode 26 umbrella
patch, telemetry-is-native) lives in the **nitropush-rn-native** skill — read it
before editing native files.

### If PROJECT_KIND = Expo

1. 🤖 **AUTO:** add the config plugin to `app.json`:
   `"plugins": [["@nitropush/react-native", { "ios": true, "android": true }]]`.
2. ✋ **NUDGE:** the user must run `expo prebuild` (and rebuild the dev client /
   reinstall pods) — that is what injects `AppDelegate.swift` /
   `MainApplication.kt` via the plugin's `// @generated` markers. You cannot run
   their native build for them. Tell them exactly which command to run.
3. 🤖 **AUTO (only if they're already bare-prebuilt and want manual):** fall
   through to the bare-RN edits below — but prefer the plugin for Expo.

### If PROJECT_KIND = bare React Native

🤖 **AUTO**, then show diffs and 🧑 **ASK** to confirm before they rebuild:

1. `ios/AppDelegate.swift` — `import NitroPushSDK` + the `bundleURL()` override,
   guarded by `#if DEBUG` (Metro in dev, OTA bundle in release).
2. `android/MainApplication.kt` — three spots: `import …NitroPushSdk`,
   `NitroPushSdk.install(this)` in `onCreate()`, and the
   `getJSBundleFile()`/`jsBundleFilePath` override under `!BuildConfig.DEBUG`.
3. `ios/Podfile` — the Xcode 26 `post_install` umbrella patch (copy the
   canonical block from `apps/react-native-example/ios/Podfile`).
4. ✋ **NUDGE:** the user runs `pod install` and rebuilds both platforms.

Always end this step by reminding them: **debug builds must still hit Metro** —
the `#if DEBUG` / `BuildConfig.DEBUG` guards are not optional.

## Step 4 — JS wiring (uses `nitropush-rn-js` skill)

🤖 **AUTO** for both PROJECT_KINDs (the JS API is identical) — see
**nitropush-rn-js** for the full surface:

1. Add `configure()` at **module scope** (top of the entry file, never inside a
   component). `configure()` takes no arguments — `serverUrl` and `storageBaseUrl`
   are hardcoded in native; the deployment key is read from the native layer.
2. Add `notifyAppReady()` in a `useEffect(() => {…}, [])` after first render.
3. Add a `sync(...)` call where updates should be checked (app foreground or a
   button), with the status callback.
4. Wire the deployment key into the native layer:
   - Expo: the config plugin writes it for you — ✋ **NUDGE** the user to pass
     `"deploymentKey": "<key>"` in the plugin config in `app.json` and re-run
     `expo prebuild`. Do not put the key in JS env vars.
   - Bare RN iOS: set `NITROPUSH_DEPLOYMENT_KEY` in `Info.plist`.
   - Bare RN Android: set `NITROPUSH_DEPLOYMENT_KEY` as `<meta-data>` in
     `AndroidManifest.xml`.
   - ✋ **NUDGE** the user to supply the real key from Step 1; leave a clearly
     marked placeholder, never a guess.

Hard rules from the JS skill that you must enforce while editing:
`configure()` is module-scope only; `notifyAppReady()` is mandatory (skipping it
causes boot-loop rollbacks); never add JS analytics (telemetry is native-only).

## Step 5 — Verify & hand off

1. 🧑 **ASK** the user to do a release build (not Metro) on a device/simulator —
   you can't run it for them.
2. Tell them how to ship the first OTA:
   - Without signing: `nitropush release upload --project <id> --environment prod --app-version 1.0.0 --label 1.0.1 --bundle-path ./dist`
   - With signing: `nitropush release upload --project <id> --environment prod --app-version 1.0.0 --label 1.0.1 --bundle-path ./dist --signing-key ./nitropush-signing.pem`
   - 🧑 **ASK** for the bundle path / app version if not obvious.
3. Confirm the success path with them: first launch → `notifyAppReady()` fires →
   later `sync()` pulls the new bundle → SDK verifies signature (if signing
   enabled) → installs.

## Things to NOT do

- **Don't skip Step 0a.** Always check you're in an app directory, not the NitroPush library — look for `nitro.json` / `.podspec` as the red flags.
- **Don't ask Expo vs bare RN when the answer is obvious** — infer it from `package.json` deps and `app.json`, state the inference, and continue. Only ask when genuinely ambiguous.
- **Don't skip Step 1.** Never assume the user needs to create a project — they
  may already have one. Ask before running any `nitropush app create` or
  `nitropush env create` command.
- **Don't skip Step 2.** Signing is opt-in but must be offered every time. It is
  much harder to add after the first release (all existing users must update their
  native binary to pick up the new public key). Offer it now.
- **Don't claim you logged the user in or built their app.** Those are ✋ NUDGE
  steps (browser OAuth, native build) — surface the command and pause.
- **Don't invent or guess a `deploymentKey`/env key.** Use a labelled placeholder
  and make the user paste the real one.
- **Don't commit the signing PEM.** Enforce `.gitignore` for `nitropush-signing.pem`
  before or immediately after generating it.
- **Don't duplicate native/JS detail here.** This skill sequences; the
  `nitropush-rn-native` / `nitropush-rn-js` / `nitropush-cli` skills own the
  specifics. Read them at the relevant step instead of guessing.
- **Don't hand-edit Nitrogen-generated files or the Expo plugin's
  `// @generated` blocks.** Re-run the generator/prebuild instead.
- **Don't commit secrets.** Env keys go in `.env` (gitignored) or CI secrets,
  never inline in committed source.

---

## nitropush-rn-js

> **When to apply:** Use when integrating NitroPush OTA updates into a React Native or Expo app's JavaScript/TypeScript code, importing from `@nitropush/react-native`, calling `configure`/`sync`/`notifyAppReady`, or editing files under `apps/expo-example/` or `apps/react-native-example/` JS layer. Covers public API, init order, sync flow, env vars, and common mistakes.

> **AGENT RULE — read this before writing any code:**
> Always use `configure()` (no arguments). Never suggest `configureWith()` unless the user explicitly says they are self-hosting or using a custom server. Never hardcode `serverUrl`, `storageBaseUrl`, or any `nitropush` URL in JS code — those are baked into the native SDK. The only value that ever appears in user code is the `NITROPUSH_DEPLOYMENT_KEY`.

The single JS package is **[`@nitropush/react-native`](../../packages/react-native/)**. Same import works in Expo and bare RN. Everything is imperative function calls — no React hooks, no `<Provider>`. The JS layer reaches into the native singleton via NitroModules on the first `configure()` call — the native module initialises lazily, you never call `NitroModules.createHybridObject` yourself.

Reference apps:
- Expo: [apps/expo-example/app/(tabs)/index.tsx](../../apps/expo-example/app/(tabs)/index.tsx)
- Bare RN: [apps/react-native-example/App.tsx](../../apps/react-native-example/App.tsx)

## Two configure paths

### 1. `configure()` — standard hosted path (always use this)

Takes **no arguments**. Reads `NITROPUSH_DEPLOYMENT_KEY` from the native layer (Info.plist on iOS, AndroidManifest `<meta-data>` on Android). `serverUrl` and `storageBaseUrl` are **hardcoded in native code** — `https://api.nitropush.org` and `https://cdn.nitropush.org` respectively — so no URLs are needed anywhere in JS or plist.

```ts
import { configure, sync, InstallMode, SyncStatus } from '@nitropush/react-native';

// Module scope — runs once before React renders
const client = configure();
```

The native module is initialized lazily on this call via NitroModules. Only set `NITROPUSH_DEPLOYMENT_KEY` in your plist/manifest (or via the Expo config plugin) — everything else is handled internally.

### 2. `configureWith(config)` — custom / self-hosted path

Pass fully explicit config. Use this only when targeting a self-hosted server or a custom CDN. Not needed for NitroPush-hosted apps.

```ts
import { configureWith } from '@nitropush/react-native';

const client = configureWith({
  serverUrl: 'https://my-server.example.com',
  deploymentKey: 'MY-KEY',
  storageBaseUrl: 'https://my-cdn.example.com/bundles',
});
```

## Lifecycle (the ONLY order that matters)

```ts
import { configure, sync, InstallMode, SyncStatus } from '@nitropush/react-native';

// 1. Module scope — before React renders, before any sync()
const client = configure(); // reads NITROPUSH_DEPLOYMENT_KEY from native; URLs are internal

function App() {
  // 2. After first successful render — confirms bundle is healthy
  useEffect(() => {
    client.notifyAppReady();
  }, []);

  // 3. When you want to check + apply updates
  const checkUpdate = async () => {
    await sync(
      client,
      { installMode: InstallMode.ON_NEXT_RESUME },
      (status, err) => { /* status callback */ },
      (progress) => { /* download progress, optional */ },
    );
  };
}
```

Why this order:
- `configure()` **must** run before any other API — it initialises the native singleton. Module scope guarantees this runs before any component mounts.
- `notifyAppReady()` **must** be called once after the JS engine has clearly succeeded in rendering. The native rollback safety net auto-reverts to the previous bundle on next launch if `notifyAppReady` was never called. Forgetting this = boot loops disguised as "update bricked the app."
- `sync()` is a coalescing facade — concurrent calls for the same client share a single in-flight operation.

## Public API (full surface)

All exports live in [packages/react-native/src/index.ts](../../packages/react-native/src/index.ts).

### Setup & lifecycle
| Function | Purpose |
|----------|---------|
| `configure(): NitroPushClient` | Reads `NITROPUSH_DEPLOYMENT_KEY` from native; `api.nitropush.org` + `cdn.nitropush.org` are hardcoded in native. Standard path. |
| `configureWith(config: NitroPushConfig): NitroPushClient` | Pass explicit `serverUrl`, `deploymentKey`, `storageBaseUrl`. Custom/self-hosted path. |

### On the returned `NitroPushClient`
| Method | Purpose |
|--------|---------|
| `client.notifyAppReady(): Promise<void>` | Mark active bundle healthy. Idempotent. Call after first render. |
| `client.restartApp(onlyIfPending: boolean): Promise<void>` | Force JS engine reload. Pass `true` to no-op when no pending update. |
| `client.checkForUpdate(keyOverride?): Promise<RemotePackage \| null>` | Low-level: query server. Returns `null` if up-to-date. |
| `client.getCurrentPackage(): Promise<LocalPackage \| null>` | Active bundle metadata (async). |
| `client.getUpdateMetadataSync(): LocalPackage \| null` | Sync variant — safe to call during first paint. |
| `client.getPendingPackage(): Promise<LocalPackage \| null>` | Bundle downloaded but not yet activated. |
| `client.clearUpdates(): Promise<void>` | Wipe all OTA state. Next launch uses binary-shipped bundle. |

### Top-level sync helper
| Function | Purpose |
|----------|---------|
| `sync(client, options?, onStatusChanged?, onProgress?): Promise<SyncStatus>` | High-level: check → optional dialog → download → install. Use this. |
| `addDownloadProgressListener(cb): () => void` | Subscribe to bytes-received events; returns unsubscribe fn. |

### Enums
- `InstallMode`: `IMMEDIATE`, `ON_NEXT_RESTART`, `ON_NEXT_RESUME`, `ON_NEXT_SUSPEND`
- `SyncStatus`: `CHECKING_FOR_UPDATE`, `AWAITING_USER_ACTION`, `DOWNLOADING_PACKAGE`, `INSTALLING_UPDATE`, `UP_TO_DATE`, `UPDATE_INSTALLED`, `UPDATE_IGNORED`, `UNKNOWN_ERROR`, `SYNC_IN_PROGRESS`

### Types (re-exported)
`NitroPushConfig`, `NitroPushClient`, `RemotePackage`, `LocalPackage`, `SyncOptions`, `UpdateDialogOptions`, `SyncStatusChangedCallback`, `DownloadProgressCallback`, `DownloadProgress`. See [packages/react-native/src/types.ts](../../packages/react-native/src/types.ts).

## `sync()` deep dive

```ts
await sync(
  client,
  {
    installMode: InstallMode.ON_NEXT_RESUME,        // when to swap the bundle
    mandatoryInstallMode: InstallMode.IMMEDIATE,    // override for mandatory updates
    minimumBackgroundDuration: 60,                  // seconds; for ON_NEXT_RESUME
    updateDialog: { /* optional — uses RN Alert if present */ },
    deploymentKey: 'override-key',                  // optional per-call override
  },
  (status, error) => {
    // Called for every state transition. error is set only for UNKNOWN_ERROR.
  },
  (progress) => {
    // { receivedBytes, totalBytes }
  },
);
```

Internally it:
1. Coalesces with any in-flight `sync()` for the same client — no race conditions.
2. Emits `CHECKING_FOR_UPDATE`.
3. If an update exists and `updateDialog` is set, emits `AWAITING_USER_ACTION` and prompts via RN `Alert`.
4. On accept: emits `DOWNLOADING_PACKAGE` → calls `client.downloadUpdate()` (native fires `download_started`/`download_completed` telemetry).
5. Emits `INSTALLING_UPDATE` → calls native `installUpdate(local, installMode, minimumBackgroundDuration)`.
6. Emits `UPDATE_INSTALLED` and resolves.
7. On any error: emits `UNKNOWN_ERROR` with the `Error`.

## Expo config plugin setup

The plugin automatically injects `NitroPushSdk.install(this)` into `MainApplication` (Android), wires `bundleURL()` into AppDelegate (iOS), and writes `NITROPUSH_DEPLOYMENT_KEY` into Info.plist / AndroidManifest. No manual native changes needed.

```json
{
  "plugins": [
    ["@nitropush/react-native", {
      "deploymentKey": "PROD-XXXXXX",
      "ios": true,
      "android": true
    }]
  ]
}
```

After `npx expo prebuild`, call `configure()` from JS at module scope and everything is wired up.

## Bare RN native setup (skip if using Expo — the config plugin handles this)

### Android — `MainApplication.kt`

Call `NitroPushSdk.install(this)` at the top of `onCreate()`, before React Native loads. This gives the SDK the Application context needed for the rollback sweep and storage.

```kotlin
import com.nitropush.sdk.NitroPushSdk

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages,
      // Serve the active OTA bundle (null falls back to binary bundle)
      jsBundleFilePath = if (BuildConfig.DEBUG) null
                         else NitroPushSdk.shared.activeBundleFile(),
    )
  }

  override fun onCreate() {
    super.onCreate()
    NitroPushSdk.install(this)   // must come before React Native bringup
    loadReactNative(this)
  }
}
```

Also set `NITROPUSH_DEPLOYMENT_KEY` in `AndroidManifest.xml`:
```xml
<application ...>
  <meta-data android:name="NITROPUSH_DEPLOYMENT_KEY" android:value="PROD-XXXXXX" />
</application>
```

### iOS — `AppDelegate.swift`

No `install()` equivalent — the SDK self-initializes when `NitroPushSdk.shared` is first accessed. Wire in `bundleURL()` so OTA bundles are served, and call `notifyAppReady()` on every foreground transition.

```swift
import NitroPush

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()
    reactNativeDelegate = delegate
    reactNativeFactory = factory
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(withModuleName: "YourApp", in: window, launchOptions: launchOptions)
    return true
  }

  // Mark the running bundle healthy on every foreground — prevents rollback
  func applicationDidBecomeActive(_ application: UIApplication) {
    NitroPushSdk.shared.notifyAppReady()
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    // Serve the active OTA bundle; falls back to binary-shipped bundle
    return NitroPushSdk.shared.activeBundleURL()
        ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
```

Set `NITROPUSH_DEPLOYMENT_KEY` in `Info.plist`:
```xml
<key>NITROPUSH_DEPLOYMENT_KEY</key>
<string>PROD-XXXXXX</string>
```

Then call `configure()` from JS at module scope as normal — the native side is already initialized.

```ts
const client = configure(); // reads NITROPUSH_DEPLOYMENT_KEY from native; URLs are internal
```

## Local dev gotcha (Android emulator)

Android emulator can't reach `localhost` — it maps to the emulator VM's own loopback. The example app rewrites `localhost` → `10.0.2.2` automatically. If rolling your own setup, use your LAN IP or the same rewrite.

## Things to NOT do

- **Don't** use `configureWith()` for NitroPush-hosted apps. The correct call is always `configure()` with no arguments. `configureWith()` is only for self-hosted servers.
- **Don't** hardcode `serverUrl`, `storageBaseUrl`, or any `nitropush.org` / `nitropush.cloud` URL in JS. Those URLs live in native — JS never sees them.
- **Don't** call `configure()` / `configureWith()` inside a component body — they re-run on every render. Module scope only.
- **Don't** skip `notifyAppReady()`. Missing it causes the next install to roll back at boot — the update silently vanishes.
- **Don't** pass arguments to `configure()` — it takes no args. Use `configureWith()` only for custom/self-hosted URLs.
- **Don't** wrap `sync()` in your own debounce/queue — it already coalesces concurrent callers via `_syncInFlight`.
- **Don't** poll `getCurrentPackage()` to detect updates — use `checkForUpdate()` or `sync()` with the status callback.
- **Don't** subscribe to download progress with `addDownloadProgressListener` AND pass `onProgress` to `sync()` for the same call — you'll get two callbacks per byte event.
- **Don't** put telemetry/analytics in JS — there's already a native analytics emitter (`/api/sdk/events`) that fires `app_started`, `download_*`, `install_*`, and `install_failed_rollback`. JS can't reliably observe cold-start rollbacks; duplicating events in JS produces double counts and misses failure cases. See the `nitropush-rn-native` skill for details.

---

## nitropush-rn-native

> **When to apply:** Use when touching NitroPush's native iOS (Swift) or Android (Kotlin) layer — editing files under `packages/nitro-sdk/ios/` or `packages/nitro-sdk/android/`, modifying the Nitro spec, the Expo config plugin, or wiring `AppDelegate.swift`/`MainApplication.kt` in a bare RN app. Covers the Nitrogen-generated bridge, on-disk bundle layout, native telemetry, and the difference between Expo (config plugin) and bare RN (manual edits) wire-up.

The native side is a **Nitrogen-generated hybrid object** with a hand-written core. JS calls hop through:
```
JS  →  HybridNitroPush (generated)  →  NitroPushSdk.shared (hand-written core)
                                    →  NlAnalytics       (native-only telemetry)
```

Spec source of truth: [packages/nitro-sdk/src/specs/NitroPush.nitro.ts](../../packages/nitro-sdk/src/specs/NitroPush.nitro.ts) — its `platforms = { ios: 'swift', android: 'kotlin' }` directive tells Nitrogen what to generate.

If you change the spec you **must** re-run `nitrogen` and check in the regenerated files; otherwise JS and native drift.

## On-disk bundle layout

| Platform | Path |
|----------|------|
| iOS | `Library/Application Support/NitroPush/<releaseId>/main.jsbundle` |
| Android | `${context.filesDir}/nitropush/<releaseId>/main.jsbundle` |

State (active / pending / previous / unconfirmed release IDs) lives in:
- iOS: `UserDefaults` keys `nitropush.active`, `nitropush.pending`, `nitropush.previous`, `nitropush.unconfirmed` (`packages/nitro-sdk/ios/NitroPushSdk.swift:31-40`)
- Android: `SharedPreferences` under name `"nitropush"` (`packages/nitro-sdk/android/src/main/java/com/nitropush/nitrosdk/NitroPushSdk.kt:87`)

These keys form a small state machine — don't touch them directly. The rollback safety net relies on the `unconfirmed` slot being cleared by `notifyAppReady()` on the next clean boot.

## iOS

- **Pod name:** `NitroPushSDK`
- **Min iOS:** 13.4
- **Pod spec:** [packages/nitro-sdk/NitroPush.podspec](../../packages/nitro-sdk/NitroPush.podspec)
- **Source:** `packages/nitro-sdk/ios/*.swift`
- **Autolinking:** `nitrogen/generated/ios/NitroPushSDK+autolinking.rb` (generated, don't edit)

Three Swift files matter:

| File | Role |
|------|------|
| [HybridNitroPush.swift](../../packages/nitro-sdk/ios/HybridNitroPush.swift) | Thin Nitrogen bridge. Delegates everything to `NitroPushSdk.shared` and translates types. |
| [NitroPushSdk.swift](../../packages/nitro-sdk/ios/NitroPushSdk.swift) | Core OTA logic: download, install, rollback, lifecycle observers. |
| [NitroPushAnalytics.swift](../../packages/nitro-sdk/ios/NitroPushAnalytics.swift) | Native event emitter (`NlAnalytics`). Buffers + flushes to `/api/sdk/events`. |

Native APIs in use: `URLSession` (60s request, 5min resource timeout), `FileManager`, `UserDefaults`, `CryptoKit` (SHA-256), `NotificationCenter` for app lifecycle.

### Wiring iOS into the host app

The runtime lookup point is `AppDelegate.bundleURL()`. The pattern is identical in Expo (auto-applied by the config plugin) and bare RN (hand-written):

```swift
override func bundleURL() -> URL? {
#if DEBUG
  return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
  if let nitropushBundleURL = NitroPushSdk.shared.activeBundleURL() {
    return nitropushBundleURL
  }
  return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
}
```

The `#if DEBUG` guard is critical — in dev you want Metro, not the OTA bundle.

### Xcode 26 — Podfile `post_install` umbrella patch

CocoaPods auto-generates `Pods/Target Support Files/NitroPushNative/NitroPushNative-umbrella.h` that `#import`s every entry in `public_header_files`, including nitrogen's C++ `.hpp` headers. Xcode 26's **strict modular headers** validates the umbrella in pure ObjC mode and any `namespace margelo::nitro …` line fails with `unknown type name 'namespace'`.

Bypasses that don't work:
- **Restricting `public_header_files`** to `["ios/Bridge.h"]` fixes the umbrella but breaks Swift's C++ interop (the nitrogen Swift typealiases can no longer resolve `margelo.nitro.nitropush.nativesdk.LocalPackage` etc.).
- **`s.module_map = "ios/NitroPushNative.modulemap"`** works for framework builds but CocoaPods explicitly rejects custom module maps for Swift **static libraries** ("currently not supported"). `MODULEMAP_FILE` injected via `post_install` gets prefixed with `${SRCROOT}/` and breaks absolute paths.

What works: a Podfile `post_install` hook that rewrites the umbrella, wrapping the `.hpp` `#imports` in `#ifdef __cplusplus`. ObjC validation skips them; Swift's C++ interop (`SWIFT_OBJC_INTEROP_MODE = objcxx`, ObjC++ mode) still picks them up.

- **Bare RN apps**: hand-write the hook into `ios/Podfile` — see [apps/react-native-example/ios/Podfile](../../apps/react-native-example/ios/Podfile) for the canonical copy.
- **Expo apps**: the `@nitropush/react-native` config plugin injects the same hook automatically via `withDangerousMod` (`patchExpoPodfile` in [packages/native/src/plugin/index.ts](../../packages/native/src/plugin/index.ts)). The mod is anchored on the Expo-specific `:ccache_enabled => ccache_enabled?(podfile_properties)` argument with `offset: 2` so it lands just after `react_native_post_install(…)` closes — but still inside the `post_install do |installer|` block.

This is **separate from** the upstream NitroModules header patch in `scripts/patch-nitro-modules.js`. That script (run as a postinstall) adds 33 missing entries to NitroModules' own `public_header_files` so transitive `#include <NitroModules/…>` resolves at all. Both fixes are required on Xcode 26 — they address different symptoms (NitroModules' missing public headers vs NitroPushNative's umbrella ObjC validation).

## Android

- **Package:** `com.nitropush.nitrosdk`
- **Gradle:** [packages/nitro-sdk/android/build.gradle](../../packages/nitro-sdk/android/build.gradle)
- **Source:** `packages/nitro-sdk/android/src/main/java/com/nitropush/nitrosdk/*.kt` (core) + `com/margelo/nitro/nitropush/nitrosdk/*.kt` (Nitrogen bridge)
- **Autolinking:** `nitrogen/generated/android/NitroPushSDK+autolinking.gradle` (generated)

Three Kotlin files matter:

| File | Role |
|------|------|
| `com/margelo/nitro/nitropush/nitrosdk/HybridNitroPush.kt` | Nitrogen bridge → delegates to `NitroPushSdk.shared`. |
| `com/nitropush/nitrosdk/NitroPushSdk.kt` | Core OTA logic. Singleton, requires `install(context)` from `MainApplication.onCreate()`. |
| `com/nitropush/nitrosdk/NitroPushAnalytics.kt` | Native event emitter mirror of iOS. |

Native APIs in use: `HttpURLConnection`, `SharedPreferences`, `MessageDigest` (SHA-256), `androidx.lifecycle.ProcessLifecycleOwner` for foreground/background, `ScheduledExecutorService` for the analytics flush timer.

### Wiring Android into the host app

`MainApplication.kt` needs three things — install on `onCreate`, override `getJSBundleFile()` (or `jsBundleFilePath` in the new `reactHost` API), and import the SDK:

```kotlin
import com.nitropush.nitrosdk.NitroPushSdk

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(applicationContext, reactNativeHost).also { host ->
      // new API
      host.jsBundleFilePath = if (BuildConfig.DEBUG) null else NitroPushSdk.shared.activeBundleFile()
    }
  }

  override fun onCreate() {
    super.onCreate()
    NitroPushSdk.install(this)        // <-- required, lazy-init guarded
    // ...rest of RN init
  }
}
```

If the host app uses the older `ReactNativeHost` API, override `getJSBundleFile()` to return `NitroPushSdk.shared.activeBundleFile()` under `!BuildConfig.DEBUG` instead.

## Telemetry — native-only by design

There is **no JS-side analytics emitter**. Trying to add one is a category error. From `packages/nitro-sdk/ios/NitroPushAnalytics.swift:18-21`:

> Replaces the deleted JS-side `createAnalyticsEmitter` so events fire even when the JS thread hasn't loaded (cold-start, post-rollback boots).

Events fired (both platforms, identical names):
- `app_started` — fired during `configure()`
- `update_check` — after each `checkForUpdate`
- `download_started` / `download_completed`
- `install_completed` — fired once per first-run release inside `notifyAppReady()`
- `install_failed_rollback` — fired at next launch when the rollback safety net trips

Queue discipline (both platforms):
- Capacity: 200 events
- Flush: every 10 events OR every 30s
- Endpoint: `POST <serverUrl>/api/sdk/events`
- Backoff: exponential, best-effort (events drop at capacity if network is dead)

If you're tempted to fire analytics from JS to "just be sure" — don't. You'll double-count `install_completed` and you still won't see `install_failed_rollback`, because by definition the JS engine of the failed bundle never ran.

## Expo config plugin (auto-wires everything above)

Source: [packages/react-native/src/plugin/index.ts](../../packages/react-native/src/plugin/index.ts) (compiled to `plugin/build/index.js`).

Rebuild after editing: `yarn workspace @nitropush/react-native build:plugin`.

### Plugin props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `deploymentKey` | `string` | **Yes** | Environment deployment key. Injected as `NITROPUSH_DEPLOYMENT_KEY` in Info.plist / AndroidManifest `<meta-data>`. |
| `serverUrl` | `string` | No | NitroPush API base URL. Injected as `NITROPUSH_SERVER_URL`; defaults in SDK to `https://api.nitropush.org`. |
| `storageBaseUrl` | `string` | No | Bundle CDN base URL. Injected as `NITROPUSH_STORAGE_BASE_URL`; defaults to `https://cdn.nitropush.org`. |
| `bundlePublicKey` | `string` | No | Base64 DER SPKI public key for bundle signature verification. Injected as `NITROPUSH_BUNDLE_PUBLIC_KEY`. Only needed when releases are uploaded with `--signing-key`. |
| `nativeConfigure` | `boolean` | No | Inject a native `configure()` + background update-check `Task.detached` into `AppDelegate.swift`. **Leave `false` (default) for Expo apps** — JS calls the no-arg `configure()` which reads from Info.plist. Set `true` only for bare-RN apps that need the SDK running before JS loads. |
| `ios` | `boolean` | No | Enable iOS wiring. Default `true`. |
| `android` | `boolean` | No | Enable Android wiring. Default `true`. |

Minimal `app.json` entry (enough for the no-arg `configure()` call to work):
```json
"plugins": [[
  "@nitropush/react-native",
  {
    "deploymentKey": "nl_live_…",
    "serverUrl": "https://api.nitropush.org"
  }
]]
```

### What prebuild injects

**iOS — `Info.plist`** (`withInfoPlist`):
- `NITROPUSH_DEPLOYMENT_KEY` (always when prop is set)
- `NITROPUSH_SERVER_URL` (when `serverUrl` prop is set)
- `NITROPUSH_STORAGE_BASE_URL` (when `storageBaseUrl` prop is set)
- `NITROPUSH_BUNDLE_PUBLIC_KEY` (when `bundlePublicKey` prop is set)

**iOS — `AppDelegate.swift`** (`withAppDelegate`):
- Tag `nitropush-ios-import`: `import NitroPushSDK`
- Tag `nitropush-ios-bundle-url`: `activeBundleURL()` short-circuit inside `bundleURL()` under `#if !DEBUG`
- Tag `nitropush-ios-notify-app-ready`: `applicationDidBecomeActive` override calling `notifyAppReady()`
- Tag `nitropush-ios-configure`: native `configure()` + background update-check `Task.detached` — **only when `nativeConfigure: true` AND both `serverUrl` and `deploymentKey` props are set** (bare-RN only; Expo apps use JS-side `configure()` instead)

**iOS — `Podfile`** (`withDangerousMod`):
- Tag `nitropush-ios-podfile-nitromodules-cxx`: sets `CLANG_CXX_LANGUAGE_STANDARD=c++20`, `SWIFT_OBJC_INTEROP_MODE=objcxx`, `CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES` on NitroModules + NitroPush pod targets; sets `SWIFT_OBJC_INTEROP_MODE=objcxx` on the main app target via `aggregate_targets`; patches `NitroModules-umbrella.h` to guard `.hpp` imports in `#ifdef __cplusplus`
- Tag `nitropush-ios-podfile-umbrella-patch`: patches `NitroPushNative-umbrella.h` to guard `.hpp` imports in `#ifdef __cplusplus`

**Android — `AndroidManifest.xml`** (`withAndroidManifest`):
- `<meta-data android:name="NITROPUSH_DEPLOYMENT_KEY" android:value="…" />`
- `<meta-data android:name="NITROPUSH_SERVER_URL" android:value="…" />` (when prop is set)
- `<meta-data android:name="NITROPUSH_STORAGE_BASE_URL" android:value="…" />` (when prop is set)
- `<meta-data android:name="NITROPUSH_BUNDLE_PUBLIC_KEY" android:value="…" />` (when prop is set)

**Android — `MainApplication.kt`** (`withMainApplication`):
- Tag `nitropush-android-import`: `import com.nitropush.nitrosdk.NitroPushSdk`
- Tag `nitropush-android-install`: `NitroPushSdk.install(this)` after `super.onCreate()`
- Tag `nitropush-android-bundle-file`: `getJSBundleFile()` override under `!BuildConfig.DEBUG`

All injections wrapped in `// @generated begin <tag> … // @generated end` markers via `mergeContents()` — **idempotent**. Re-running `expo prebuild` is safe and produces no diff if the SDK version hasn't changed.

## Native configure() — Swift type name and defaults

When `nativeConfigure: true` is set, the config plugin injects `NPConfig(…)` into `AppDelegate.swift`. The correct Swift type is **`NPConfig`**, not `NlConfig` or `NitroPushConfig`. Using the wrong name gives `cannot find 'NlConfig' in scope` at build time.

`deploymentKey` is the only required argument — `serverUrl` defaults to `"https://api.nitropush.org"` and `storageBaseUrl` defaults to `"https://cdn.nitropush.org"`:

```swift
try NitroPushSdk.shared.configure(NPConfig(deploymentKey: "nl_live_…"))
```

Only pass the URL args for self-hosted deployments. The Android equivalent type is `NPConfig` (same defaults — `NlConfig` was the old NitroLift-era name, now removed).

## iOS simulator — DNS cache & ATS gotchas

**Stale NXDOMAIN in simulator**: After adding a new DNS record (e.g. pointing `api.nitropush.org` or `cdn.nitropush.org` at a new IP), iOS simulators cache the old NXDOMAIN and keep returning `NSURLErrorDomain Code=-1003 (cannot find host)`. Fix: erase the simulator to flush its DNS cache:
```bash
xcrun simctl erase <simulator-udid>   # or "all" for all simulators
```

**ATS and bare IP addresses**: `NSAllowsLocalNetworking: true` in `Info.plist` only exempts `localhost` and `*.local` hostnames — it does **not** exempt bare IP addresses like `192.168.0.141`. To allow plain-HTTP to a local dev server by IP you must set `NSAllowsArbitraryLoads: true`. In Expo apps add this to `app.json`:
```json
"ios": {
  "infoPlist": {
    "NSAppTransportSecurity": { "NSAllowsArbitraryLoads": true }
  }
}
```
For production, remove `NSAllowsArbitraryLoads` entirely and use HTTPS.

## Xcode 26 — C++ interop chain detail

The `SWIFT_OBJC_INTEROP_MODE = objcxx` flag must propagate through the **entire** dependency chain, not just the pod targets. Missing it on the main app target causes:

```
module 'NitroPush' was built with C++ interoperability enabled,
but current compilation does not enable C++ interoperability
```

The Podfile `post_install` hook sets it on the **main app target** via `installer.aggregate_targets` (the `user_project`, not `pods_project`):

```ruby
installer.aggregate_targets.each do |agg|
  agg.user_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['SWIFT_OBJC_INTEROP_MODE'] = 'objcxx'
    end
  end
  agg.user_project.save   # must call save or the .xcodeproj is not written
end
```

Three-level fix required:
1. `NitroModules` pod: `CLANG_CXX_LANGUAGE_STANDARD=c++20`, `SWIFT_OBJC_INTEROP_MODE=objcxx`, `CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES`
2. `NitroPush` pod: same three settings
3. Main app target: `SWIFT_OBJC_INTEROP_MODE=objcxx` via `installer.aggregate_targets`

The config plugin applies all three automatically — this is only relevant when hand-editing the Podfile in a bare RN app.

## Bare RN vs Expo summary

| Concern | Expo | Bare RN |
|---------|------|---------|
| iOS wire-up | Plugin injects into `AppDelegate.swift` | Hand-edit `AppDelegate.swift` (`bundleURL()`) |
| Android wire-up | Plugin injects into `MainApplication.kt` | Hand-edit `MainApplication.kt` (3 spots) |
| Podfile / Gradle | Expo build system + Nitrogen autolinking | Nitrogen autolinking (no manual Pod/Gradle edits for the module itself) |
| Sync after SDK update | `expo prebuild --clean` | Re-apply hand edits if injection points changed |
| Reference app | [apps/expo-example/](../../apps/expo-example/) | [apps/react-native-example/](../../apps/react-native-example/) |

## Things to NOT do

- **Don't edit Nitrogen-generated files** under `packages/nitro-sdk/nitrogen/generated/` or `packages/nitro-sdk/android/.../com/margelo/nitro/...`. They get overwritten. Edit the spec instead.
- **Don't add JS analytics.** Telemetry is native-only by design — see the `Telemetry` section above.
- **Don't bypass `NitroPushSdk.install(context)` on Android.** It's the only place the singleton wires up `ProcessLifecycleOwner` observers; without it `ON_NEXT_RESUME`/`ON_NEXT_SUSPEND` install modes never trigger.
- **Don't hard-code paths.** Use `activeBundleURL()` (iOS) / `activeBundleFile()` (Android) — they encapsulate the on-disk layout and may change.
- **Don't return the OTA bundle in DEBUG.** Always guard with `#if DEBUG` (iOS) / `BuildConfig.DEBUG` (Android) so dev builds still hit Metro.
- **Don't touch `nitropush.active`/`nitropush.pending`/`nitropush.previous`/`nitropush.unconfirmed`** in UserDefaults/SharedPreferences from outside the SDK. Use `clearPendingUpdate()` / `clearUpdates()` from JS instead.
- **Don't call `notifyAppReady()` from native code.** It's exposed as a JS API for a reason — the JS engine being healthy enough to call it is itself the signal. Calling it from native short-circuits the rollback safety net.
- **Don't use `NlConfig`** in `AppDelegate.swift` — the correct Swift type is `NPConfig`. `NlConfig` was the old NitroLift-era name; using it gives `cannot find 'NlConfig' in scope` at build time.
- **Don't use `NSAllowsLocalNetworking: true`** expecting it to cover bare IP addresses — it only covers `localhost`/`*.local`. Use `NSAllowsArbitraryLoads: true` for bare IPs (dev only), HTTPS in production.
