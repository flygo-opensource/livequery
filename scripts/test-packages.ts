const packages = ['core', 'd1']

for (const name of packages) {
  const process = Bun.spawn(['bun', 'test', 'tests/'], {
    cwd: new URL(`../${name}/`, import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${name} tests failed with exit code ${exitCode}`)
}
