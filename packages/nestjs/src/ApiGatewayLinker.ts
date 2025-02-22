import { Inject, Injectable, Optional } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { listPaths } from "./helpers/listPaths.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { LivequeryWebsocketSync, WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { merge, Subject, of, mergeMap, firstValueFrom, timer } from "rxjs";
import { API_GATEWAY_NAMESPACE } from "./const.js";
import { filter, tap, combineLatestWith, throttleTime, debounceTime, groupBy } from 'rxjs/operators'
import { RxjsUdp } from "./RxjsUdp.js";



// Cơ chế 
// Service gọi gateway khởi động lần đầu với auth không có gì 
// Gateway gọi service kèm token xác thực
// Service gọi lại kèm token xác thực 
// Gateway ghép nối 

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