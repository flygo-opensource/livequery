import { Injectable } from '@nestjs/common'
import { ApiGatewayHandler, type ApiGatewayOptions } from '@livequery/core'

@Injectable()
export class SimpleApiGateway extends ApiGatewayHandler {
    constructor(options: ApiGatewayOptions = {}) {
        super(options)
    }
}

export type { RegisterOptions } from '@livequery/core'
