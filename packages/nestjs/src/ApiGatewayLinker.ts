import { Controller, Inject, Injectable, Optional } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { listPaths } from "./helpers/listPaths.js";
import { ServiceApiMetadata } from "./ApiGateway.js";
import { LivequeryWebsocketSync, WEBSOCKET_PATH } from "./LivequeryWebsocketSync.js";
import { Subject, map, filter, debounceTime, mergeMap, firstValueFrom, tap, ReplaySubject} from "rxjs";
import { RxjsUdp } from "./RxjsUdp.js";
import { API_GATEWAY_NAMESPACE, NODE_ID } from "./const.js";


@Controller()
@Injectable()
export class ApiGatewayLinker {

    private static $me = new ReplaySubject<{ name: string, port: number }>(1)

    constructor(
        @Optional() @Inject() LivequeryWebsocketSync: LivequeryWebsocketSync,
        private readonly modulesContainer: ModulesContainer,
    ) {
        const paths = [...this.modulesContainer.values()].map(m => (
            listPaths([...m.controllers.keys()].map(c => c))
        )).flat(2)

        const metadata$ = ApiGatewayLinker.$me.pipe(map(({ name, port }) => {
            const metadata: ServiceApiMetadata = {
                node_id: NODE_ID,
                host: '',
                namespace: API_GATEWAY_NAMESPACE,
                name,
                port,
                role: 'service',
                paths,
                linked: [],
                wsauth: LivequeryWebsocketSync?.auth,
                websocket: LivequeryWebsocketSync ? WEBSOCKET_PATH : undefined
            }
            return metadata;
        })) as any as ReplaySubject<ServiceApiMetadata>
        const udp$ = new RxjsUdp<ServiceApiMetadata>()

        udp$.link(metadata$).pipe(
            filter(node => node.role == 'gateway'),
            debounceTime(1000),
            mergeMap(async node => {
                const metadata = await firstValueFrom(metadata$)
                await udp$.broadcast({
                    hi: false,
                    node: metadata,
                    sender_id: metadata.node_id
                })
            })
        ).subscribe()
    }


    static async broadcast(name: string, port: number) {
        this.$me.next({ name, port })
    }
}