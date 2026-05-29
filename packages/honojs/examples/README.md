# Examples

Run examples with Bun from the `@livequery/honojs` package directory.

## Service API

Starts a Hono service and broadcasts its routes with `UdpDiscovery`.

```sh
bun examples/service-api.ts
```

Direct request:

```sh
curl http://127.0.0.1:3001/livequery/products
```

## API Gateway

Starts a gateway that auto-discovers service APIs through `UdpDiscovery`.

```sh
bun examples/api-gateway.ts
```

In another terminal, start the service example:

```sh
bun examples/service-api.ts
```

Then request through the gateway:

```sh
curl http://127.0.0.1:3000/livequery/products
```

## Datasource Mapper

Shows `createDatasourceMapper()` with an in-memory datasource.

```sh
bun examples/datasource.ts
curl http://127.0.0.1:3002/livequery/datasource/products
```
