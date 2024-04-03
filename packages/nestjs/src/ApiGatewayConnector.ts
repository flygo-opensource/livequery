import { Injectable, Provider } from "@nestjs/common";
import { LivequeryWebsocketSync, listPaths } from "./index.js";
import { WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { ServiceApiMetadata } from "./ApiGateway.js";

export const ApiGatewayConnectorConfigKey = Symbol.for(`ApiGatewayConnectorConfigKey`)

@Injectable()
export class ApiGatewayConnector {

    private constructor(
        private metadata: ServiceApiMetadata
    ) { }



    static add(name: string, controllers: any[], port: number) {

        return {
            provide: ApiGatewayConnector,
            inject: [{ token: LivequeryWebsocketSync, optional: true }],
            useFactory: async (ws: LivequeryWebsocketSync) => (
                new this(
                    {
                        name,
                        paths: listPaths(controllers),
                        port,
                        websocket: ws ? WEBSOCKET_PATH : undefined
                    }
                )
            )
        } as Provider
    }


    list() {
        return this.metadata
    }

}