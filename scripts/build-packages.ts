// d1 depends on core, so core builds first.
const packages = ['core', 'd1']

for (const name of packages) {
  const process = Bun.spawn(['bun', 'run', 'build'], {
    cwd: new URL(`../${name}/`, import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${name} build failed with exit code ${exitCode}`)
}
