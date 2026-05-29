import { Injectable } from '@nestjs/common'

// Replaced by WebsocketGateway from @livequery/core.
// Kept as a no-op class so existing NestJS module arrays that include it still compile.
@Injectable()
export class LivequeryWebsocketSync {}
