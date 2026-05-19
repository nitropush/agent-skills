---
name: nitropush-rn-js
description: Use when integrating NitroPush OTA updates into a React Native or Expo app's JavaScript/TypeScript code, importing from `@nitropush/react-native`, calling `configure`/`sync`/`notifyAppReady`, or editing files under `apps/expo-example/` or `apps/react-native-example/` JS layer. Covers public API, init order, sync flow, env vars, and common mistakes.
globs:
  - "packages/nitro-sdk/src/**"
  - "apps/expo-example/**/*.{ts,tsx,js,jsx}"
  - "apps/react-native-example/**/*.{ts,tsx,js,jsx}"
alwaysApply: false
---

# NitroPush — React Native JS integration

The single JS package is **[`@nitropush/react-native`](../../packages/nitro-sdk/)**. Same import works in Expo and bare RN. There are no React hooks, no `<Provider>` — everything is imperative function calls on a singleton hybrid object created once via `NitroModules.createHybridObject('NitroPush')` (`packages/nitro-sdk/src/codepush.ts:21`).

Reference apps:
- Expo: [apps/expo-example/app/(tabs)/index.tsx](../../apps/expo-example/app/(tabs)/index.tsx)
- Bare RN: [apps/react-native-example/App.tsx](../../apps/react-native-example/App.tsx)

## Lifecycle (the ONLY order that matters)

```ts
// 1. At module scope — runs once on app boot, BEFORE any sync()
import { configure, sync, notifyAppReady, InstallMode, SyncStatus } from '@nitropush/react-native';

configure({
  serverUrl: process.env.EXPO_PUBLIC_NITROPUSH_SERVER_URL!,
  deploymentKey: process.env.EXPO_PUBLIC_NITROPUSH_DEPLOYMENT_KEY!,
  storageBaseUrl: process.env.EXPO_PUBLIC_NITROPUSH_STORAGE_BASE_URL!,
});

// 2. Inside a React component, after first successful render
useEffect(() => {
  notifyAppReady();   // confirms current bundle is healthy → cancels pending rollback
}, []);

// 3. When you want to check + apply updates (often on app foreground or a button)
await sync(
  { installMode: InstallMode.ON_NEXT_RESUME },
  (status, err) => { /* status callback */ },
  (progress) => { /* download progress, optional */ },
);
```

Why this order:
- `configure()` **must** run before any other API — it sets the singleton's server URL and deployment key. Putting it at module scope (top of the file, not inside a component) guarantees this.
- `notifyAppReady()` **must** be called once after the JS engine has clearly succeeded in rendering. The native rollback safety net auto-reverts to the previous bundle on next launch if `notifyAppReady` was never called for the current bundle. Forgetting this = boot loops disguised as "update bricked the app."
- `sync()` is a coalescing facade — concurrent calls share a single in-flight operation.

## Public API (full surface)

All exports live in [packages/nitro-sdk/src/index.ts](../../packages/nitro-sdk/src/index.ts).

### Setup & lifecycle
| Function | Purpose |
|----------|---------|
| `configure(config: NitroPushConfig): void` | Set `serverUrl`, `deploymentKey`, `storageBaseUrl`, optional `appVersion`/`deviceId`. Call once at module scope. |
| `notifyAppReady(): Promise<void>` | Mark the active bundle healthy. Idempotent. Call after first successful render. |
| `restartApp(onlyIfUpdateIsPending = false): Promise<void>` | Force JS engine reload. Pass `true` to be a no-op when there's no pending update. |

### Update orchestration
| Function | Purpose |
|----------|---------|
| `sync(options?, onStatusChanged?, onProgress?): Promise<SyncStatus>` | High-level: check → optional dialog → download → install. Use this. |
| `checkForUpdate(deploymentKeyOverride?): Promise<RemotePackage \| null>` | Low-level: just query the server. Returns `null` if up-to-date. |
| `addDownloadProgressListener(cb): () => void` | Subscribe to bytes-received events; returns unsubscribe fn. Useful when not calling `sync()` directly. |

### Inspection
| Function | Purpose |
|----------|---------|
| `getUpdateMetadata(): Promise<LocalPackage \| null>` | Active bundle metadata (async). |
| `getUpdateMetadataSync(): LocalPackage \| null` | Sync variant — safe to call during first paint without `await`. |
| `getPendingUpdate(): Promise<LocalPackage \| null>` | Bundle that's downloaded but not yet activated. |

### Cleanup
| Function | Purpose |
|----------|---------|
| `clearPendingUpdate(): Promise<void>` | Discard a pending install. |
| `clearUpdates(): Promise<void>` | Wipe all OTA state. Next launch falls back to the binary-shipped bundle. |

### Enums
- `InstallMode`: `IMMEDIATE`, `ON_NEXT_RESTART`, `ON_NEXT_RESUME`, `ON_NEXT_SUSPEND`
- `SyncStatus`: `CHECKING_FOR_UPDATE`, `AWAITING_USER_ACTION`, `DOWNLOADING_PACKAGE`, `INSTALLING_UPDATE`, `UP_TO_DATE`, `UPDATE_INSTALLED`, `UPDATE_IGNORED`, `UNKNOWN_ERROR`, `SYNC_IN_PROGRESS`

### Types (re-exported)
`NitroPushConfig`, `RemotePackage`, `LocalPackage`, `UpdateMetadata`, `SyncOptions`, `UpdateDialogOptions`, `SyncStatusChangedCallback`, `DownloadProgressCallback`, `DownloadProgress`. See [packages/nitro-sdk/src/types.ts](../../packages/nitro-sdk/src/types.ts).

## `sync()` deep dive

```ts
await sync(
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
1. Coalesces with any in-flight `sync()` (no race conditions if you call it from multiple places).
2. Emits `CHECKING_FOR_UPDATE`.
3. If an update exists and `updateDialog` is set, emits `AWAITING_USER_ACTION` and prompts via RN `Alert`.
4. On accept: emits `DOWNLOADING_PACKAGE` → calls native `downloadUpdate()` (native fires `download_started`/`download_completed` telemetry).
5. Emits `INSTALLING_UPDATE` → calls native `installUpdate(local, installMode, minimumBackgroundDuration)`.
6. Emits `UPDATE_INSTALLED` and resolves.
7. On any error: emits `UNKNOWN_ERROR` with the `Error`.

## Env vars and config

### Expo (`apps/expo-example/.env`)
```
EXPO_PUBLIC_NITROPUSH_SERVER_URL=https://app.nitropush.cloud
EXPO_PUBLIC_NITROPUSH_DEPLOYMENT_KEY=PROD-XXXXXX
EXPO_PUBLIC_NITROPUSH_STORAGE_BASE_URL=https://cdn.nitropush.cloud/bundles
```
Plus the config plugin in [apps/expo-example/app.json](../../apps/expo-example/app.json):
```json
"plugins": [["@nitropush/react-native", { "ios": true, "android": true }]]
```

### Bare RN
No `.env` magic — pass values directly:
```ts
configure({
  serverUrl: 'https://app.nitropush.cloud',
  deploymentKey: 'PROD-XXXXXX',
  storageBaseUrl: 'https://cdn.nitropush.cloud/bundles',
});
```

### What each value means
- `serverUrl` — admin server (where `checkForUpdate` POSTs).
- `deploymentKey` — environment key (the `key` column on the `environments` row); identifies which env the device should subscribe to.
- `storageBaseUrl` — public base URL for bundle/asset object storage (S3, MinIO, CDN). Server returns relative `objectKey`s; SDK joins them with this base.

## Local dev gotcha (Android emulator)

Android emulator can't reach `localhost` — it points at the host's loopback inside the emulator VM. The example app rewrites `localhost` → `10.0.2.2` automatically. If you're rolling your own setup, do the same, or use your LAN IP.

## Things to NOT do

- **Don't** call `configure()` inside a component body — it'll re-run on every render and there's no guard. Module scope only.
- **Don't** skip `notifyAppReady()`. The next install will roll back at boot and you'll spend hours debugging "the update vanished."
- **Don't** wrap `sync()` in your own debounce/queue — it already coalesces concurrent callers via `_syncInFlight`.
- **Don't** poll `getUpdateMetadata()` to detect updates — use `checkForUpdate()` or `sync()` with the status callback.
- **Don't** subscribe to download progress with `addDownloadProgressListener` AND pass `onProgress` to `sync()` for the same call — you'll get two callbacks for every byte event.
- **Don't** put telemetry/analytics in JS — there's already a native analytics emitter (`/api/sdk/events`) that fires `app_started`, `download_*`, `install_*`, and `install_failed_rollback`. JS can't reliably observe cold-start rollbacks; trying to duplicate the events in JS will produce double counts and miss the failure cases that matter most. See the `nitropush-rn-native` skill for details.
