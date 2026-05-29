import { Controller, Inject, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { type IncomingMessage, type ServerResponse } from 'http'
import { type Response } from 'express'
import { ApiGatewayHandler, type ServiceApiMetadata, type ServiceApiStatus, UdpDiscovery, WebsocketGateway } from '@livequery/core'
export type { ServiceApiMetadata, ServiceApiStatus }

export type ApiGatewayClientOptions = {
    id: string
    name: string
    controllers: any[]
    port: number
}

@Controller()
export class ApiGateway implements OnModuleInit, OnModuleDestroy {
    readonly #linker: ApiGatewayHandler
    readonly #lws?: WebsocketGateway
    readonly #httpAdapterHost: HttpAdapterHost | undefined

    constructor(
        @Optional() @Inject(WebsocketGateway) lws: WebsocketGateway,
        @Optional() @Inject(UdpDiscovery) discovery: UdpDiscovery<ServiceApiMetadata> | undefined,
        @Optional() @Inject(HttpAdapterHost) httpAdapterHost: HttpAdapterHost | undefined,
    ) {
        this.#lws = lws
        this.#httpAdapterHost = httpAdapterHost
        this.#linker = new ApiGatewayHandler({
            ws: lws,
            ...(discovery ? { discovery } : {}),
        })
    }

    onModuleInit(): void {
        const app = this.#httpAdapterHost?.httpAdapter?.getInstance?.()
        if (!app) return

        for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
            if (typeof app[method] === 'function') {
                app[method]('*', (req: IncomingMessage & { url: string; method: string; rawBody: Buffer }, res: Response) => {
                    void this.#proxy(req, res)
                })
            }
        }
    }

    onModuleDestroy(): void {
        this.#linker.close()
    }

    #proxy(req: IncomingMessage & { url: string; method: string; rawBody: Buffer }, res: Response) {
        if (Number(req.headers['content-length'] || 0) > 0 && !req.rawBody) {
            res.status(500)
            return res.json({
                error: {
                    status: 500,
                    code: 'MISSING_API_GATEWAY_RAW_BODY',
                    message: 'Please enable rawBody = true in NestFactory.create()'
                }
            })
        }

        const client_id = req.headers['x-lcid'] || req.headers['socket_id']
        const extraHeaders = client_id && this.#lws ? {
            'x-lcid': client_id as string,
            'x-lgid': (req.headers['x-lgid'] ?? this.#lws.id) as string
        } : undefined

        return this.#linker.fetch(req, res as unknown as ServerResponse, extraHeaders)
    }
}
