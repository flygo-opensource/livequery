import { Logger, Module } from "@nestjs/common";
import { ApiGateway } from "../src/ApiGateway.js";
import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'

@Module({
    controllers: [ApiGateway],
    providers: [LivequeryWebsocketSync,Logger]
})
export class AppModule { }


const app = await NestFactory.create(AppModule, { rawBody: true })
// app.useWebSocketAdapter(new WsAdapter(app))
await app.listen(process.argv[2] || 8000) 