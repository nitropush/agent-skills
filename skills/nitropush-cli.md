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
  [--kind expo|codepush]          # override auto-detection
```

Auto-detection logic: `metadata.json` present → expo, otherwise walks for `.hbc`/`.jsbundle` → codepush.

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
# GitHub Actions example
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

`--token` skips the browser flow entirely — required in CI.

## Things to NOT do

- Don't invent commands. The full set is: `login`, `logout`, `whoami`, `org create`, `app create`, `app list`, `env create`, `key rotate`, `key validate`, `release create|upload|promote|list|rollout|bundle-create`, `interactive`/`wizard`. That's it.
- Don't assume `--json` works on commands other than `whoami`.
- Don't write `nitropush config set ...` — there is no `config` command. Edit `~/.nitropush/config.json` directly or use env vars.
- Don't expect positional args anywhere — every value is a named flag.
- Don't use `nitropush release create` for normal deploys — it requires you to already have an S3 key + checksum. Use `release upload` instead, which handles upload + checksum + create in one step.
