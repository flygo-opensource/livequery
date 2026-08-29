import type { LivequeryHandler } from "./LivequeryContext.js"

export type LivequeryDatasourceInitConfig<Config> = Config & {
    method: string
    path: string
}



export type LivequeryDatasource<RouteConfig> = LivequeryHandler & {
    init(routes: Array<LivequeryDatasourceInitConfig<RouteConfig>>): Promise<void> | void
}
