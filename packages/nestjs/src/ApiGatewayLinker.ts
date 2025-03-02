import { Controller, Inject, Injectable, Optional } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { listPaths } from "./helpers/listPaths.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { LivequeryWebsocketSync, WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { Subject, mergeMap } from "rxjs";
import { filter, combineLatestWith, debounceTime, groupBy } from 'rxjs/operators'
import { RxjsUdp } from "./RxjsUdp.js";


@Controller()
@Injectable()
export class ApiGatewayLinker {

    private static $me = new Subject<{ name: string, port: number }>()

    constructor(
        @Optional() @Inject() LivequeryWebsocketSync: LivequeryWebsocketSync,
        private readonly modulesContainer: ModulesContainer,
    ) {
        const paths = [...this.modulesContainer.values()].map(m => (
            listPaths([...m.controllers.keys()].map(c => c))
        )).flat(2)

        const $udp = new RxjsUdp<ServiceApiMetadata>()


        $udp.pipe(
            filter(m => m.role == 'gateway'),
            filter(r => !r.linked.includes(RxjsUdp.id)),
            combineLatestWith(ApiGatewayLinker.$me),
            groupBy(([a, b]) => a.id),
            mergeMap($ => $.pipe(
                debounceTime(1000),
                mergeMap(async ([{ host }, { name, port }]) => {
                    const payload: ServiceApiMetadata = {
                        role: 'service',
                        paths,
                        linked: [],
                        wsauth: LivequeryWebsocketSync?.auth,
                        websocket: LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined,
                        name,
                        port,
                    }
                    $udp.broadcast({
                        payload,
                        host
                    })
                })
            ))
        ).subscribe()
        
        ApiGatewayLinker.$me.subscribe(({ name, port }) => {
            $udp.broadcast({
                payload: {
                    name,
                    port,
                    role: 'service',
                    paths,
                    linked: [],
                    wsauth: LivequeryWebsocketSync?.auth,
                    websocket: LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined
                }
            })
        })


    }


    static async broadcast(name: string, port: number) {
        this.$me.next({ name, port })
    }
}