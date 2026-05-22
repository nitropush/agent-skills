---
name: nitropush-rn-js
description: Use when integrating NitroPush OTA updates into a React Native or Expo app's JavaScript/TypeScript code, importing from `@nitropush/react-native`, calling `configure`/`sync`/`notifyAppReady`, or editing files under `apps/expo-example/` or `apps/react-native-example/` JS layer. Covers public API, init order, sync flow, env vars, and common mistakes.
globs:
  - "packages/react-native/src/**"
  - "apps/expo-example/**/*.{ts,tsx,js,jsx}"
  - "apps/react-native-example/**/*.{ts,tsx,js,jsx}"
alwaysApply: false
---

# NitroPush — React Native JS integration

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
