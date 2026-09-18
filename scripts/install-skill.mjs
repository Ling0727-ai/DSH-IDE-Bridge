import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(packageRoot, 'skills', 'dsh-ide-bridge')
const skillsRoot = process.env.DSH_SKILLS_DIR ?? path.join(os.homedir(), '.dsh', 'skills')
const destination = path.join(skillsRoot, 'dsh-ide-bridge')

await mkdir(skillsRoot, { recursive: true })

try {
  const existing = await lstat(destination)
  if (!existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-link skill path: ${destination}`)
  }
  const target = path.resolve(skillsRoot, await readlink(destination))
  if (target !== source) {
    throw new Error(`Refusing to replace skill link pointing elsewhere: ${destination} -> ${target}`)
  }
  await rm(destination)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`Installed dsh-ide-bridge skill: ${destination} -> ${source}`)
