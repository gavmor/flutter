# Morphic Memory Swarm

A WebXR memory space: hold a palm up or pinch to summon a butterfly, speak, and release it into a room-shaped semantic constellation. Pluck a hovering butterfly with a near-hand/controller pinch to hear its HRTF voice memo and inspect its note card. Desktop browsers can record from the lower control bar or release a typed semantic note.

## Run locally

```bash
npm install
npm run dev
```

Open the HTTPS Vite URL (or localhost). Microphone permission is requested before an XR session starts. The first XR action lazily loads Whisper and the mixedbread 384-dimensional text embedding model in a worker; model download and WebGPU availability determine startup time.

The application uses Transformers.js 4.3.2 and UIKit 1.0.78. The worker keeps the WebGPU Whisper and normalized text-embedding pipeline APIs; UIKit panels use native containers with inherited pixel sizing and alpha colors instead of deprecated root wrappers and opacity properties. Patched transitive dependencies are resolved through these maintained releases, without dependency overrides.

## Privacy and data

Recordings stay in the browser as compressed Blob URLs and worker memory. Audio is not uploaded by this app. Reloading or leaving the page disposes the worker, microphone stream, audio URLs, and spatial registry. Browser microphone permission, WebGPU support, and headset room-scanning permissions are controlled by the browser/device.

## XR and browser limits

- Immersive AR/VR requires a WebXR-capable browser and headset; AR room meshes/planes depend on the device's scene-understanding support.
- Hand tracking requires the `hand-tracking` feature. Controllers use trigger/squeeze hold actions. Desktop pointer clicks are available for inspecting a note, but XR plucking requires a near-hand/controller gesture.
- Audio playback waits for browser autoplay policy and reports decode/resume failures on the note card. Ambient pentatonic chimes can be muted. The listener provider disconnects its own gain node on cleanup; Three's browser-wide `AudioContext` remains library-owned and is not closed during React StrictMode cleanup or provider unmount.
- The desktop **Load AI** action initializes the worker independently of microphone permission or XR entry; typed notes become available once it reports ready.
- No desktop room scan is inferred. Until a real scan arrives, the spatial core reports its actual unscanned/partial state; it does not claim a physical room boundary.
## Project layout

- `src/app.tsx` — XR canvas, lifecycle orchestration, desktop controls, capability/status surface.
- `src/audio/` — microphone warmup, compressed recording, 16 kHz mono PCM conversion, and one shared XR `AudioListener`.
- `src/components/` — butterfly visuals, HRTF memo playback, UIKit inspection card, and semantic filaments.
- `src/xr-systems/` — hand/controller summon gesture and single ECS swarm loop.
- `src/state/` and `src/worker/` — reactive metadata, mutable kinematics, ASR/embedding, PCA, and room quantization.

## Git checks

Run `npm install` in a Git checkout to install Lefthook's `pre-commit`,
`commit-msg`, and `pre-push` hooks. If Git metadata is restored after installing
dependencies, run `npx lefthook install`. Gitleaks is a separate prerequisite:
install [Gitleaks 8.28 or newer](https://github.com/gitleaks/gitleaks#installing)
and put `gitleaks` on `PATH`. Missing tools fail the hook rather than skipping it.

### Before commit

- Biome checks formatting, recommended lint rules, and import organization on
  staged supported file paths. It never writes or re-stages files.
- TypeScript checks the project when source, tests, compiler settings, or package
  files change. jscpd checks the whole source tree with a 0% duplication threshold
  when source or package files change; staged-only duplicate scans would miss
  copies of unchanged code.
- Gitleaks scans the staged diff with redacted output.
- ast-grep enforces the WebXR rules described below on staged TypeScript/TSX.
  Rule/config changes run the rule tests and a full source scan.
- CSpell checks supported staged text paths. Add legitimate project terminology
  to `cspell.json`; do not whitelist misspellings.
- Git's staged `diff --check` rejects newly added conflict markers and whitespace
  errors. Regular staged files above 1 MiB are rejected.
- Dependency-relevant manifest changes require a staged, matching npm lockfile.
  Script-only edits do not require a lockfile change.

Lefthook hides unstaged portions of partially staged files during `pre-commit`
and restores them afterward. Biome, spelling, and architecture checks read those
staged file versions. Secret/file/lockfile guards inspect the index directly.
Whole-project checks may still see unstaged edits in other files. No command
automatically adds changes to the commit.

### Commit messages

Use Conventional Commits, for example `feat: add room recording` or
`fix(audio): release microphone tracks`. Commitlint validates the message file
passed by Git. Its conventional preset retains the standard merge/revert ignores.

### Before push

Architecture rule tests and a full source scan also run before push.

Knip checks unused files, exports, and dependencies; the existing `tsx` core test
suite runs in full. A production dependency audit runs when the pushed files
include `package.json` or `package-lock.json`. Audit requires network access and
fails on reported production vulnerabilities at any severity. No check uses
`--no-exit-code` or silently suppresses findings.

### Manual checks

```bash
npm run lint
npm run typecheck
npm run duplicates
npm run lint:ast
npm run test:ast
npm run lint:spelling -- src tests scripts README.md
npm run lint:unused
npm run test:core
npm run audit:dependencies
npx lefthook run pre-commit
npx lefthook run pre-push
```

Manual Lefthook runs can skip jobs when there are no matching changed files; use
`--force` to run them regardless. The hooks are strict: existing formatting,
lint, type, spelling, duplication, unused-code, or audit findings must be resolved
before the corresponding commit or push can succeed.

## WebXR architecture checks

`sgconfig.yml` registers `rules/`, `rule-tests/`, and the TSX parser for both
`.ts` and `.tsx`. `npm run build` runs rule tests and scans `src/` before Vite.
The rules are error-level checks; none has an automatic fix or re-stages files.
`test:ast` uses ast-grep's native valid/invalid tests without output snapshots.

The rules guard direct Three.js math construction/cloning and state-setter calls
inside inline `useFrame` callbacks, reactive `kinematics` selectors, audio
messages without the matching transfer buffer, Drei `Html`, and Transformers
imports outside `src/worker/`. The existing worker/UI isolation rule remains.

These are syntactic guards, not a proof of zero allocations or zero-copy across
arbitrary helper calls, aliases, or dynamic dataflow. Review called helpers and
profile the frame loop. Setter-name matching is a heuristic, not React binding
analysis. A transfer list moves buffer ownership; it does not prove the audio
conversion path allocates nothing.

Allocate scratch objects outside the frame callback with an appropriate lifetime:
per-instance memoized/ref storage for instance state, or module scope only for
safe shared synchronous scratch use. Do not replace reactive selectors with
`getState()` automatically; read transient data inside frame/event callbacks
without changing metadata subscriptions.
