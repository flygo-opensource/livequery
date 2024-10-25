import { Controller, Get, Inject, Optional } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { listPaths } from "./helpers/listPaths.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { LivequeryWebsocketSync, WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { BehaviorSubject, merge } from "rxjs";
import { randomUUID, createHash } from "crypto";
import { API_GATEWAY_NAMESPACE } from "./const.js";
import { filter, tap } from 'rxjs/operators'
import { RxjsUdp } from "./RxjsUdp.js";


const $METADATA = new BehaviorSubject<ServiceApiMetadata>({
    namespace: API_GATEWAY_NAMESPACE,
    role: 'service',
    host: '',
    id: randomUUID(),
    name: '',
    paths: [],
    port: 0,
    sig: ''
})


@Controller('/api-gateway')
export class ApiGatewayLinker {

    private static udp = new RxjsUdp()

    constructor(
        @Optional() @Inject() private LivequeryWebsocketSync: LivequeryWebsocketSync,
        private readonly modulesContainer: ModulesContainer,
    ) {
        const paths = [...this.modulesContainer.values()].map(m => (
            listPaths([...m.controllers.keys()].map(c => c))
        )).flat(2)
        $METADATA.next({
            ...$METADATA.getValue(),
            paths,
            websocket: this.LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined
        })
    }

    onModuleInit() {
        $METADATA.next({
            ...$METADATA.getValue(),
            sig: createHash('md5').update(API_GATEWAY_NAMESPACE).digest('base64')
        })
    }

    static async broadcast(name: string, local_api_port: number) {

        $METADATA.next({
            ...$METADATA.getValue(),
            name,
            port: local_api_port
        })

        const $udp = new RxjsUdp()

        merge(
            $udp.pipe(
                filter(m => m.role == 'gateway')
            ),
            $METADATA.pipe(
                filter(m => !!m.sig)
            )
        ).pipe(
            tap(() => $udp.broadcast($METADATA.getValue()))
        ).subscribe()
    }

    @Get('metadata')
    metadata() {
        return {
            data: $METADATA.getValue()
        }
    }
}