// Dependency order: core first, then what builds on it; client before rest and react.
const packages = ['core', 'd1', 'mongodb', 'postgres', 'honojs', 'nestjs', 'discovery', 'client', 'rest', 'rpc', 'react']

for (const name of packages) {
  const process = Bun.spawn(['bun', 'test', 'tests/'], {
    cwd: new URL(`../packages/${name}/`, import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${name} tests failed with exit code ${exitCode}`)
}
