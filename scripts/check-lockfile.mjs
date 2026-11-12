import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

const RELEVANT_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'overrides',
  'workspaces',
  'name',
  'version',
  'packageManager',
  'engines',
]

// npm does not serialize overrides or packageManager in lockfile root metadata.
// They still require a staged lockfile change, but cannot be compared there.
const LOCK_ROOT_FIELDS = RELEVANT_FIELDS.filter(
  (field) => field !== 'overrides' && field !== 'packageManager',
)

function git(args, input) {
  const result = spawnSync('git', args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = Buffer.concat([result.stdout, result.stderr])
      .toString('utf8')
      .trimEnd()
    throw new Error(details || `git ${args[0]} failed (${result.status}).`)
  }
  return result.stdout
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJSON(content, label) {
  let value
  try {
    value = JSON.parse(content.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`)
  }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object.`)
  return value
}

function readHeadManifest() {
  const record = git(['cat-file', '--batch-check'], 'HEAD:package.json\n')
    .toString('ascii')
    .trimEnd()
  // This also covers an unborn branch without writing an empty tree object.
  if (record === 'HEAD:package.json missing') return {}
  const match = /^([0-9a-f]+) blob [0-9]+$/.exec(record)
  if (!match) throw new Error(`Cannot read HEAD package.json: ${record}`)
  return parseJSON(git(['cat-file', 'blob', match[1]]), 'HEAD package.json')
}

function readIndexJSON(entries, path) {
  const entry = entries.get(path)
  if (!entry || (entry.mode !== '100644' && entry.mode !== '100755')) {
    throw new Error(`Stage ${path} as a regular file before committing.`)
  }
  return parseJSON(git(['cat-file', 'blob', entry.oid]), `Staged ${path}`)
}

function lockValue(pkg, field) {
  let value = pkg[field]
  if (field === 'dependencies' && isObject(value)) {
    // npm removes dependencies also listed as optional; optional takes priority.
    value = Object.fromEntries(
      Object.entries(value).filter(
        ([name]) => !Object.hasOwn(pkg.optionalDependencies ?? {}, name),
      ),
    )
  }
  // npm omits empty dependency maps, engines, workspaces, and empty identity.
  if (
    value == null ||
    value === '' ||
    (typeof value === 'object' && Object.keys(value).length === 0)
  ) {
    return undefined
  }
  return value
}

function main() {
  const paths = ['package.json', 'package-lock.json']
  const pathspecs = paths.map((path) => `:(top,literal)${path}`)
  const changed = new Set(
    git([
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--ita-invisible-in-index',
      '-z',
      '--',
      ...pathspecs,
    ])
      .toString('utf8')
      .split('\0'),
  )
  if (!changed.has('package.json')) return

  const entries = new Map()
  for (const record of git([
    'ls-files',
    '--stage',
    '--full-name',
    '-z',
    '--',
    ...pathspecs,
  ])
    .toString('utf8')
    .split('\0')) {
    if (!record) continue
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(record)
    if (!match) throw new Error('Unexpected Git index entry.')
    const [, mode, oid, stage, path] = match
    if (stage !== '0') {
      throw new Error(`Resolve unmerged ${path} before committing.`)
    }
    entries.set(path, { mode, oid })
  }
  const manifest = readIndexJSON(entries, 'package.json')
  const previous = readHeadManifest()
  if (
    RELEVANT_FIELDS.every((field) =>
      isDeepStrictEqual(previous[field], manifest[field]),
    )
  ) {
    return
  }
  if (!changed.has('package-lock.json')) {
    throw new Error(
      'Dependency-relevant package.json fields changed. Regenerate and stage package-lock.json together with package.json.',
    )
  }

  const lock = readIndexJSON(entries, 'package-lock.json')
  if (
    (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) ||
    !isObject(lock.packages) ||
    !isObject(lock.packages[''])
  ) {
    throw new Error(
      'Staged package-lock.json must use npm lockfileVersion 2 or 3 with a packages[""] root object.',
    )
  }
  const mismatches = LOCK_ROOT_FIELDS.filter(
    (field) =>
      !isDeepStrictEqual(
        lockValue(manifest, field),
        lockValue(lock.packages[''], field),
      ),
  )
  for (const field of ['name', 'version']) {
    const expected = lockValue(manifest, field)
    // npm can use a folder name in the header when the manifest has no name.
    if (expected !== undefined && !isDeepStrictEqual(lock[field], expected)) {
      mismatches.push(`${field} (lockfile header)`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Staged package-lock.json does not match staged package.json: ${mismatches.join(', ')}. Regenerate the lockfile and stage both files.`,
    )
  }
}

try {
  main()
} catch (error) {
  console.error(`check-lockfile: ${error.message}`)
  process.exitCode = 1
}
