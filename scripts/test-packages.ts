const packages = ['service', 'discovery-file', 'gateway', 'gateway-controller', 'gateway-controller-nginx', 'gateway-controller-kong', 'gateway-controller-cloudflare']

for (const name of packages) {
  const process = Bun.spawn(['bun', 'test'], {
    cwd: new URL(`../packages/${name}/`, import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${name} tests failed with exit code ${exitCode}`)
}
