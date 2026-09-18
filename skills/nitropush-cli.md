---
name: nitropush-cli
description: Use when the user asks about the NitroPush CLI (`nitropush` binary), wants to script releases/uploads/rollouts, asks about CLI auth/login/whoami, or is editing files under `packages/cli/`. Covers every subcommand, required flags, config file location, env vars, and CI patterns.
globs:
  - "packages/cli/**"
  - "**/.nitropush/config.json"
  - "**/.github/workflows/*release*.yml"
alwaysApply: false
---

# NitroPush CLI

The `nitropush` binary is a Commander.js CLI that drives the NitroPush admin API. Source: [packages/cli/](../../packages/cli/). Binary entry: [packages/cli/src/index.ts](../../packages/cli/src/index.ts) (compiled to `dist/index.js`, registered as `bin.nitropush` in [packages/cli/package.json](../../packages/cli/package.json)).

## Mental model

The CLI is a thin wrapper over the admin API at `serverUrl` (default `https://app.nitropush.org`) and data API at `apiUrl` (default `https://api.nitropush.org`). Release uploads reserve a signed release context and submit content through authenticated API operations; do not script direct bucket writes. Three things to remember:

1. **Auth state** lives in `~/.nitropush/config.json` — `{ serverUrl, apiUrl, token?, orgId?, userId? }`. The signed token has decodable claims; offline decoding does not verify server revocation or establish trust.
2. **All subcommands take explicit flags** — never positional args. This makes the CLI safe to script.
3. **`release upload` is the canonical deploy command** — it auto-detects Expo (looks for `metadata.json`) vs CodePush (looks for `.hbc`/`.jsbundle`), computes SHA-256 and signs the reserved release context. NativeScript must use explicit `--kind nativescript` with a complete built app tree.

## Auth

```bash
# Interactive (opens the dashboard; generate a token and paste it into the CLI)
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

Browser login uses `/cli-login?flow=manual`, not a loopback listener. The pasted token is verified against the server before it is saved.

**Env var overrides** (read at runtime, win over config file):
- `NITROPUSH_SERVER_URL` — server URL
- `CODEPUSH_SERVER_URL` — fallback server URL (legacy)
- `NITROPUSH_API_URL` — data API URL
- `NITROPUSH_API_TOKEN` — token override (`CODEPUSH_API_TOKEN` is the legacy fallback)

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
Organizations are created through atomic web signup. The legacy `org create`
command intentionally returns an error; do not use it to create a workspace.

### App
```bash
nitropush app create --org <orgId> --name "MyApp"
nitropush app list   --org <orgId>
nitropush app create --name "NativeScript app" --framework nativescript
nitropush app signing-key generate --app <appId> --out ./nitropush-signing.pem --public-out ./nitropush-signing.public.b64
```

### Environment
```bash
nitropush env create --app <appId> --name prod --key-out ./nitropush-prod-key.txt
```

### Environment key (rotation)
```bash
nitropush key rotate \
  --env <environmentId> \
  --grace-seconds 86400 \
  --out ./nitropush-prod-key.next.txt

nitropush key list --env <environmentId>
nitropush key validate --env <environmentId> --key-id <keyId>
nitropush key revoke --env <environmentId> --key-id <keyId>
```

The server generates each 256-bit deployment key and stores only its SHA-256
hash. Create/rotate responses reveal the plaintext once; the CLI writes it to a
new `0600` file and never prints it. Use `--revoke-immediately` instead of
`--grace-seconds` only when an immediate cutover is intended. Releases are
key-generation-bound; publish a fresh release for the replacement generation.

### Release — the workflow you'll use 95% of the time

```bash
# Auto-detect + upload (preferred)
nitropush release upload \
  --project <projectId> \
  --environment prod \
  --runtime-version 1.0.0 \           # native binary version, or '*' for universal
  --label 1.0.5 \                 # release label
  --bundle-path ./dist-ios \      # Expo: dist-<platform>/ dir | CodePush: .hbc / .jsbundle
  [--platforms ios,android] \     # defaults to project's configured platforms
  [--assets-dir ./assets] \       # CodePush only
  [--kind expo|codepush|nativescript] \        # override auto-detection
  [--signing-key <path>]          # path to ECDSA P-256 private key PEM; required when project has a bundle-signing public key configured
```

Auto-detection logic: `metadata.json` present → expo, otherwise walks for `.hbc`/`.jsbundle` → codepush.

**Bundle signing (`--signing-key`):** Pass a file path to a PEM-encoded ECDSA P-256 private key. The CLI signs the bundle before upload; the server verifies the signature against the public key stored in project settings. Always required for NativeScript, and required when an RN/Expo project has bundle-signing enabled. The public key must also be compiled into the native binary. **Never pass the PEM content directly as a flag value** — write it to a temp file first to avoid leaking it in process listings.

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


### NativeScript release workflow

Use the `nitropush-nativescript` skill for bootstrap/runtime/asset details.
Build NativeScript with its own Webpack pipeline, not `release upload --bundle`.

```bash
nitropush release upload \
  --project PROJECT_ID \
  --environment test \
  --platforms android \
  --runtime-version EXACT_NATIVE_RUNTIME_FINGERPRINT \
  --label "image-update" \
  --kind nativescript \
  --bundle-path ./platforms/android/app/src/main/assets/app \
  --signing-key ./nitropush-signing.pem \
  --delta
```

Read the matching platform's `platforms/<platform>/nitropush-runtime.json`.
Upload iOS separately using its own runtime and the app/ in the actual built .app.
No wildcard runtime, unsigned tree, native binary, or RN-project target is valid.
`--app-version` remains a deprecated alias for `--runtime-version`.

`--delta` reuses unchanged hashes and uses npdiff1 changed-file patches only when
at least 20% smaller, with full-file fallbacks. It requires a compatible previous
tree; a new runtime starts with full files. RN/Expo use a separate bsdiff4 path.

The visible OTA version is an automatic integer starting at 1 per project,
environment and runtime target; reservations can leave gaps. The label and
native fingerprint are separate from that sequence and from content SHA-256.
Never relabel/resequence already-signed payloads or use the bundle hash as a
native compatibility target. CLI savings exclude manifest/base64/transport
overhead and are not billable CDN bytes.

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
      --runtime-version "${{ github.ref_name }}" \
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
      --runtime-version "${{ github.ref_name }}" \
      --label "${{ github.sha }}" \
      --bundle-path ./dist-ios \
      --signing-key "${SIGNING_KEY_FILE}"

    rm -f "${SIGNING_KEY_FILE}"
```

`--token` skips the browser flow entirely — required in CI.

## Things to NOT do

- Don't invent commands. Verify installed-version flags with `--help`. Source command groups include `login`, `logout`, `whoami`, `org`, `app`, `env`, `embedded`, `key`, `release`, and `interactive`/`wizard`. The `embedded upload` bundle-baseline flow does not replace NativeScript's complete signed tree.
- Don't promote a signed release by mutating its context. Upload and sign a fresh release for the destination environment.
- Don't assume `--json` works on commands other than `whoami`.
- Don't write `nitropush config set ...` — there is no `config` command. Edit `~/.nitropush/config.json` directly or use env vars.
- Don't expect positional args anywhere — every value is a named flag.
- Don't use `nitropush release create` for normal deploys — it requires you to already have an S3 key + checksum. Use `release upload` instead, which handles upload + checksum + create in one step.
