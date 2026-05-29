---
name: nitropush-integration
description: Use when a user wants to ADD/INTEGRATE NitroPush OTA updates into their app for the first time ("integrate nitropush", "set up nitropush", "add OTA updates", "onboard my app"). This is the end-to-end onboarding playbook — it sequences account setup, native wiring, and JS wiring, and delegates the details to the nitropush-cli, nitropush-rn-native, and nitropush-rn-js skills. NOT for questions about an already-integrated app.
globs:
  - "**/app.json"
  - "**/app.config.{js,ts}"
  - "**/ios/**/AppDelegate.swift"
  - "**/android/**/MainApplication.{kt,java}"
alwaysApply: false
---

# NitroPush — integration playbook (onboarding a new app)

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

## Step 0 — 🧑 ASK: Expo or bare React Native? (MANDATORY GATE)

**Before anything else, every time, ask:**

> "Is this an **Expo** app (managed/prebuild, has `app.json`/`app.config.*` and an
> Expo config-plugin list) or a **bare React Native** app (you hand-edit
> `ios/AppDelegate.swift` and `android/MainApplication.kt`)?"

Do not infer silently and proceed — confirm with the user even if you see an
`app.json`, because bare RN apps have one too. Every later step branches on this
answer. If they don't know: presence of `"expo"` in `package.json` deps + an
`expo` key in `app.json` ⇒ Expo; an `ios/` + `android/` folder you're expected to
edit by hand ⇒ bare RN. Still confirm the inference out loud.

Record the answer. Refer to it as **PROJECT_KIND** below.

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

- **Don't skip Step 0.** Never assume Expo vs bare RN from the presence of
  `app.json` alone — both have one. Ask, every time.
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
