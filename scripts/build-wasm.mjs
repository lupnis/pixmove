import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const outDir = resolve(root, 'src/wasm/generated')

await mkdir(outDir, { recursive: true })

const ascBin = resolve(root, 'node_modules/assemblyscript/bin/asc.js')

try {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      ascBin,
      'src/wasm/morph.ts',
      '-o',
      'src/wasm/generated/morph.wasm',
      '-O3z',
      '--runtime',
      'stub',
      '--noAssert',
    ],
    { cwd: root },
  )

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
}
