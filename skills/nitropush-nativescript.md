---
name: nitropush-nativescript
description: Integrate or troubleshoot @nitropush/nativescript in a NativeScript app, or publish its signed application-tree and file-delta updates. Use for NativeScript prepare hooks, runtime fingerprints, assets after OTA, and restart-only lifecycle. Not the React Native or Expo SDK.
globs:
  - "**/nativescript.config.*"
  - "**/hooks/after-prepare/nitropush.js"
  - "packages/nativescript/**"
  - "apps/nativescript-example/**"
alwaysApply: false
---

# NitroPush NativeScript

Use this workflow for NativeScript, including react-nativescript apps. Import
`@nitropush/nativescript`, never the React Native/Nitro Modules package.
The integration is alpha, not a production certification.

## Establish the target

Read the app's package.json, nativescript.config.ts and prepare hook. Resolve the
actual application root; a NativeScript entry point need not be App.tsx. In the
NitroPush monorepo, distinguish SDK development from integrating an example.
Check installed SDK/CLI versions and `nitropush release upload --help`; source
support does not mean the npm package or production backend is already updated.

Reuse the user's project, environment, platform and keypair. If any target is
unknown, ask before creating or publishing. NativeScript needs project framework
`nativescript`, a single platform's built output per upload, and required signing.
Never convert an existing React Native project or infer permission to deploy.

For an explicitly requested new project:

```sh
nitropush app create --name "My app" --framework nativescript
nitropush env create --app PROJECT_ID --name test --key-out ./nitropush-test-key.txt
```

The CLI saves a one-time deployment key in a new 0600 file. Keep it gitignored and
out of logs. When no signing trust root exists and the user authorizes creating
one, `nitropush app signing-key generate --app PROJECT_ID --out ./nitropush-signing.pem --public-out ./nitropush-signing.public.b64`
registers the public key. Do not regenerate it for each release. Private PEM files
remain in protected release tooling, never the app; keep the complete base64 DER
SPKI public key (not just its fingerprint) in the native build configuration.

## Prepare native startup

Validated templates: CLI/core 9.1.1, Android 9.1.1, iOS 9.1.0, Webpack 5.0.38.
The native engine requires iOS 15+; the tested Android app uses minSdk 26.
Vite, snapshots, and SwiftUI bootstrap are unsupported. Unknown startup templates
must fail preparation, not be patched by guesswork.

Add `hooks/after-prepare/nitropush.js`:

```js
module.exports = function ($projectData, hookArgs) {
  const platform = hookArgs.platform || hookArgs.prepareData?.platform;
  if (!platform) throw new Error('Missing NativeScript prepare platform');
  require('@nitropush/nativescript/scripts/prepare.cjs')
    .prepare($projectData.projectDir, platform.toLowerCase());
};
```

Provide `NITROPUSH_DEPLOYMENT_KEY` and `NITROPUSH_BUNDLE_PUBLIC_KEY` through the
private build environment. The hook writes native config and
`platforms/<platform>/nitropush-runtime.json`. Rebuild a native release binary to
adopt the bootstrap, signing root or decoder. Do not hand-edit generated
`platforms/` files. SDK maintainers edit canonical Swift/Kotlin sources under
`packages/react-native/` and run `yarn workspace @nitropush/nativescript build`
to sync copies; never patch generated copies.

## Application lifecycle

```ts
import { configure, sync, InstallMode } from '@nitropush/nativescript';
const client = configure(); // Module scope, no arguments.
// In the first usable screen's loaded / after-render callback:
await client.notifyAppReady();
// In a user action or lifecycle handler after configuration:
await sync(client, { installMode: InstallMode.ON_NEXT_RESTART });
```

Only `ON_NEXT_RESTART` exists. `UPDATE_INSTALLED` means staged; verify after a cold
process restart. Never confirm app readiness at module initialization.
The client exposes `getCurrentPackage()`, `getPendingPackage()`,
`clearPendingUpdate()`, and `notifyAppReady()`. Metadata is
`{releaseId, label, appVersion, isPending}`. Sync statuses are
`CHECKING_FOR_UPDATE`, `UP_TO_DATE`, `UPDATE_INSTALLED`, `UNKNOWN_ERROR`.
Do not invent RN-only methods such as `configureWith`, `restartApp`, immediate/
resume/suspend install modes or progress callbacks. Native telemetry already
exists; do not add duplicate JS analytics.

## Signed releases and deltas

Build the complete release-mode Webpack app tree. Include emitted package.json,
entry script, chunks, workers, CSS/XML, fonts and images. Android's validated
directory is `platforms/android/app/src/main/assets/app`. On iOS, locate the
`app/` inside the actual built .app (possibly DerivedData); do not use stale
output. Neither the source app/ nor the whole native build is an upload input.

```sh
nitropush release upload \
  --project PROJECT_ID \
  --environment test \
  --platforms android \
  --runtime-version EXACT_RUNTIME_FROM_NATIVE_BUILD \
  --label "image-update" \
  --kind nativescript \
  --bundle-path ./platforms/android/app/src/main/assets/app \
  --signing-key ./nitropush-signing.pem \
  --delta
```

Use the other platform's exact output/runtime for iOS. `--app-version` is a
deprecated alias. `--bundle` does not build NativeScript. Unsigned, wildcard
runtime and framework-mismatched uploads must remain rejected. Never pass PEM
contents as a flag.

`--delta` compares the previous tree with identical project/environment/platform/
runtime/deployment generation. Unchanged files are content-hash references;
changed files use npdiff1 when at least 20% smaller, otherwise full files.
The server reconstructs and verifies the signed target and retains full fallbacks.
Updated native clients automatically apply patches; no RN `enableDeltaUpdates`
flag. Missing/corrupt bases or patches safely fall back. Never modify the active
tree in place or bypass signed target verification to get a delta working.

## Keep identities separate

- OTA version: server-allocated integer starting at 1 per project/environment/
  runtime target, with possible reservation gaps. Never rewrite signed sequences.
- Label: human-facing name, independent from compatibility.
- Runtime fingerprint: platform, native bootstrap ABI/sources, dependency versions,
  lockfile, NativeScript config and App_Resources. New inputs require a new binary.
- Bundle/file SHA-256: content integrity and cache identity. JS/assets can change
  without a native runtime change. It cannot replace the runtime fingerprint.

The emitted package.json and Android native registration script must equal the
binary baseline. If fingerprint changes, investigate native/lockfile inputs;
never force an old runtime or derive it from the current JS bundle.

## Verify, then report evidence

For an authorized test: signed full tree → sync → cold launch → readiness → signed
delta → cold launch. Verify image paths (`~/assets/...`) on iOS and Android.
Check wrong key/tampered file rejection, safe missing/corrupt base fallback,
offline startup and rollback after missing readiness. SDK builds/tests alone
do not prove the device launch. Do not reset device data outside the named test app.

Patch-byte telemetry is not actual CDN/billable bandwidth; exclude manifest,
base64, HTTP/TLS and cache hits from claimed patch savings. A fallback event may
coexist with successfully patched files in one NativeScript update.
State exactly which platforms and paths were tested and which remain unverified.
Workers/lazy imports, interrupted install/power loss, native upgrades and physical
devices remain alpha release gates until separately tested.

Full user guide: https://docs.nitropush.org/docs/sdk/nativescript .
In this repo, `packages/nativescript/README.md` and
`docs/nativescript-file-delta-validation.md` hold implementation constraints and
the recorded test evidence. Publishing packages, changing production and rotating
keys are separate actions requiring the user's scope/authorization.
