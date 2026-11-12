import { spawnSync } from 'node:child_process'

const MAX_BLOB_BYTES = 1024 * 1024

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

function main() {
  // Git checks newly staged conflict markers AND whitespace errors according to
  // core.whitespace. Neither this command nor the blob-size check edits files.
  git([
    'diff',
    '--cached',
    '--check',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
  ])

  // Disable rename detection so a rename's destination is checked as an add.
  // Latin-1 preserves raw filename bytes, including non-UTF-8 paths; NUL is the
  // only separator. No filenames are interpolated into a command or shell.
  const changedPaths = new Set(
    git([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMT',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--ita-invisible-in-index',
      '-z',
    ])
      .toString('latin1')
      .split('\0')
      .filter(Boolean),
  )
  const entries = []
  for (const record of git(['ls-files', '--stage', '--full-name', '-z'])
    .toString('latin1')
    .split('\0')) {
    if (!record) continue
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(record)
    if (!match) throw new Error('Unexpected Git index entry.')
    const [, mode, oid, stage, path] = match
    if (stage !== '0') {
      throw new Error('Resolve all unmerged index entries before committing.')
    }
    // Symlink targets are blobs too, but only regular files have a size limit.
    // Gitlinks (submodules) need not exist in this repository's object store.
    if (changedPaths.has(path) && (mode === '100644' || mode === '100755')) {
      entries.push({ oid, path })
    }
  }
  if (entries.length === 0) return

  const oids = [...new Set(entries.map(({ oid }) => oid))]
  const records = git(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    `${oids.join('\n')}\n`,
  )
    .toString('ascii')
    .trimEnd()
    .split('\n')
  if (records.length !== oids.length) {
    throw new Error('Git did not return all staged blob sizes.')
  }
  const sizes = new Map()
  for (const [index, record] of records.entries()) {
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(record)
    if (!match || match[1] !== oids[index]) {
      throw new Error(`Cannot read staged blob size: ${record}`)
    }
    sizes.set(match[1], BigInt(match[2]))
  }
  const oversized = entries.filter(
    ({ oid }) => sizes.get(oid) > BigInt(MAX_BLOB_BYTES),
  )
  if (oversized.length > 0) {
    const details = oversized.map(({ oid, path }) => {
      const filename = JSON.stringify(
        Buffer.from(path, 'latin1').toString('utf8'),
      )
      return `  ${filename}: ${sizes.get(oid)} bytes`
    })
    throw new Error(
      `Staged regular files exceed 1 MiB (${MAX_BLOB_BYTES} bytes):\n${details.join('\n')}`,
    )
  }
}

try {
  main()
} catch (error) {
  console.error(`check-staged: ${error.message}`)
  process.exitCode = 1
}
