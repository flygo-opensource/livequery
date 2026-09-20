// Pieces shared by the /bun and /node entries: discovery-driven gateway and service linker.
export * from './api-gateway.js'
export * from './api-service-linker.js'
export {
    ApiGatewayHandler,
    ApiServiceLinker,
    API_GATEWAY_NAMESPACE,
    HttpDiscovery,
    WEBSOCKET_PATH,
    type ServiceApiMetadata,
} from '@livequery/core/bun'
