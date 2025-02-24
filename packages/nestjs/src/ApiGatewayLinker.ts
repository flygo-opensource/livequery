import { Controller, Inject, Injectable, Optional } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { listPaths } from "./helpers/listPaths.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { LivequeryWebsocketSync, WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { merge, Subject, of, mergeMap } from "rxjs";
import { API_GATEWAY_NAMESPACE } from "./const.js";
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

        const $udp = new RxjsUdp()

        const metadata: ServiceApiMetadata = {
            namespace: API_GATEWAY_NAMESPACE,
            role: 'service',
            id: $udp.id,
            name: 'seeding-service',
            paths,
            port: 0,
            linked: [],
            auth: '',
            wsauth: LivequeryWebsocketSync?.auth,
            websocket: LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined
        }

        merge(
            $udp,
            of({ ...metadata, role: 'gateway' })
        ).pipe(
            filter(m => m.role == 'gateway'),
            filter(r => !r.linked.includes($udp.id)),
            combineLatestWith(ApiGatewayLinker.$me),
            groupBy(([a, b]) => a.id),
            mergeMap($ => $.pipe(
                debounceTime(500),
                mergeMap(async ([a, { name, port }]) => {
                    const me: ServiceApiMetadata = {
                        ...metadata,
                        name,
                        port,
                        auth: a.auth
                    }
                    $udp.broadcast(me)
                })
            ))
        ).subscribe()
    }


    static async broadcast(name: string, port: number) {
        this.$me.next({ name, port })
    }
}