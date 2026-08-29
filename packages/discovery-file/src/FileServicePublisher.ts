import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServiceManifest, ServicePublisher } from '@livequery/service'

export type FileServicePublisherOptions = {
  directory: string
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!safe) throw new Error('Service manifest id cannot be empty')
  return safe
}

/** Writes one atomically-replaced JSON file per service instance. */
export class FileServicePublisher implements ServicePublisher {
  readonly #directory: string
  #path?: string

  constructor({ directory }: FileServicePublisherOptions) {
    this.#directory = directory
  }

  async publish(manifest: ServiceManifest): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    const file = `${safeFilePart(manifest.serviceId)}-${safeFilePart(manifest.instanceId)}.json`
    const target = join(this.#directory, file)
    const temporary = `${target}.${process.pid}.${manifest.seq}.tmp`
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
    await rename(temporary, target)
    this.#path = target
  }

  async close(): Promise<void> {
    const path = this.#path
    this.#path = undefined
    if (!path) return
    await unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}
