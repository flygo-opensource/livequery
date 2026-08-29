const groups = [
  ['protocol', 'service', 'discovery'],
  ['discovery-http', 'discovery-file', 'gateway', 'realtime', 'gateway-controller'],
  ['realtime-node', 'realtime-bun', 'realtime-cloudflare', 'gateway-controller-nginx', 'gateway-controller-kong', 'gateway-controller-cloudflare'],
]

for (const group of groups) {
  const builds = group.map(async name => {
    const process = Bun.spawn(['bun', 'run', 'build'], {
      cwd: new URL(`../packages/${name}/`, import.meta.url).pathname,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await process.exited
    if (exitCode !== 0) throw new Error(`${name} build failed with exit code ${exitCode}`)
  })
  await Promise.all(builds)
}
