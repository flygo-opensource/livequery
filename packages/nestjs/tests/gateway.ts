import { Controller, Get, Module } from "@nestjs/common";
import { ApiGateway } from "../src/ApiGateway.js";
import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'

@Module({
    controllers: [ApiGateway],
    providers: [LivequeryWebsocketSync]
})
export class AppModule { }


const app = await NestFactory.create(AppModule, { rawBody: true })
app.useWebSocketAdapter(new WsAdapter(app))
await app.listen(8081)