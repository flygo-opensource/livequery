import { Controller, Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common'
import { ModulesContainer } from '@nestjs/core'
import { ApiServiceLinker as CoreApiServiceLinker, UdpDiscovery, type ServiceApiMetadata, WebsocketGateway } from '@livequery/core'
import { listPaths } from './helpers/listPaths.js'

@Controller()
@Injectable()
export class ApiServiceLinker implements OnModuleDestroy {
    private static readonly instances = new Set<ApiServiceLinker>()

    readonly #linker: CoreApiServiceLinker

    constructor(
        @Optional() @Inject(WebsocketGateway) lws: WebsocketGateway,
        @Optional() @Inject(UdpDiscovery) discovery: UdpDiscovery<ServiceApiMetadata> | undefined,
        modulesContainer: ModulesContainer,
    ) {
        const paths = [...modulesContainer.values()].flatMap(m => (
            listPaths([...m.controllers.keys()].map(c => c))
        ))
        this.#linker = new CoreApiServiceLinker({
            paths,
            ws: lws,
            ...(discovery ? { discovery } : {}),
        })
        ApiServiceLinker.instances.add(this)
    }

    start(name: string, port: number): void {
        this.#linker.start(name, port)
    }

    close(): void {
        ApiServiceLinker.instances.delete(this)
        this.#linker.close()
    }

    onModuleDestroy(): void {
        this.close()
    }

    static async broadcast(name: string, port: number): Promise<void> {
        for (const instance of this.instances) {
            instance.start(name, port)
        }
    }
}
