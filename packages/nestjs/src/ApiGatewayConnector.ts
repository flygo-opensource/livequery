import { Inject, Injectable, Optional, Provider } from "@nestjs/common";
import { LivequeryWebsocketSync, listPaths } from "./index.js";
import { WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { ServiceApiStatusMetadata } from "./ApiGateway.js";
import { networkInterfaces } from "os";

export const ApiGatewayConnectorConfigKey = Symbol.for(`ApiGatewayConnectorConfigKey`)
export type ApiGatewayConnectorConfig = Omit<ServiceApiStatusMetadata, 'host' | 'ws_path'>

@Injectable()
export class ApiGatewayConnector {

    private constructor(
        @Inject(ApiGatewayConnectorConfigKey) private metadata: ApiGatewayConnectorConfig,
        @Optional() @Inject(LivequeryWebsocketSync) private LivequeryWebsocketSync?: LivequeryWebsocketSync
    ) { }

    static link(controllers: any[], port: number) {

        const metadata: ApiGatewayConnectorConfig = {
            http_paths: listPaths(controllers),
            port
        }

        return {
            provide: ApiGatewayConnector,
            inject: [ApiGatewayConnectorConfigKey],
            useFactory: () => metadata
        } as Provider
    }

    list() {
        const metadata = {
            ...this.metadata,
            ws_path: this.LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined,
            ip_address: networkInterfaces()
        }
        return metadata
    }

}