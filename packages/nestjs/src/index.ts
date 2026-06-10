export { ApiServiceLinker } from './ApiServiceLinker.js'
export { listPaths } from './helpers/listPaths.js'
export { UdpDiscovery, type UdpDiscoveryNode, type UdpDiscoveryOptions, type UdpDiscoveryPacket, type UdpDiscoveryStatus, WebsocketGateway, type RealtimeSubscription } from '@livequery/core'
export { LivequeryRequest } from './LivequeryRequest.js'
export { LivequeryInterceptor, UseLivequeryInterceptor } from './LivequeryInterceptor.js'
export * from './helpers/createDatasourceMapper.js'
export * from './LivequeryDatasourceInterceptors.js'
export { ApiGateway, ApiGateway as ApiGatewayLinker } from './ApiGatewayLinker.js'

// Shared type surface, re-exported from @livequery/core (previously from @livequery/types).
// `LivequeryRequest` is intentionally omitted — the nestjs-specific version is exported
// above (./LivequeryRequest.js).
export type {
    LivequeryDatasource,
    LivequeryDatasourceInitConfig,
    LivequeryBaseEntity,
    UpdatedData,
    UpdatedDataType,
    WebsocketSyncPayload,
    DatabaseEvent,
    Paging,
    QueryOption,
    BasicOptions,
    SummaryQuery,
    SummaryOperator,
    GroupByOperator,
    FilterConditions,
    ConditionTypeBuilder,
    FlatObjectKeys,
    ChainObjectKeys,
    RequestMethod,
    Eq, Neq, NumberNotEqual, Lt, Eqn, Lte, Gt, Gte,
    Visible, InArray, NotInArray, Like, OrderBy,
} from '@livequery/core'
