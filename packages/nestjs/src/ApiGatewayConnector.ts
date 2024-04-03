import { Injectable, Provider } from "@nestjs/common";
import { LivequeryWebsocketSync, listPaths } from "./index.js";
import { WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { networkInterfaces } from "os";
import { ReplaySubject, firstValueFrom, mergeMap, interval, takeUntil, tap, timer } from "rxjs";
import http from 'http'

export const ApiGatewayConnectorConfigKey = Symbol.for(`ApiGatewayConnectorConfigKey`)

@Injectable()
export class ApiGatewayConnector {

    #ready = new ReplaySubject<void>(1)

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


    async list() {

        const ip_addresses = (
            Object.entries(networkInterfaces())
                .filter(([$interface]) => $interface.startsWith('lo'))
                .map(([_, list]) => {
                    return list.map(item => item.address)
                })
                .flat(2)
        )

        return {
            ip_addresses,
            metadata: this.metadata
        }
    }

}