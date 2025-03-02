import { Controller, Get, Module } from "@nestjs/common";
import { ApiGateway } from "../src/ApiGateway.js"; 
import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'
import { UseLivequeryInterceptor } from "../src/LivequeryInterceptor.js";
import { ApiGatewayLinker } from "../src/index.js";



@Controller('livequery/pets')
export class PetCollection {


    constructor(
        private ws: LivequeryWebsocketSync
    ) {
        let i = 0
        setInterval(() => {
            ws.broadcast({
                type: 'modified',
                old_ref: 'pets',
                new_ref: 'pets',
                old_data: {
                    id: '123',
                    length: i
                },
                new_data: {
                    id: '123',
                    length: ++i
                }
            })
        }, 5000)
    }

    @Get(['', ':id'])
    @UseLivequeryInterceptor()
    list() {
        return {
            items: [
                {
                    id: '123',
                    legnth: 0
                }
            ]
        }
    }
}


@Module({
    controllers: [ApiGatewayLinker, PetCollection],
    providers: [ LivequeryWebsocketSync]
})
export class AppModule { }

const app = await NestFactory.create(AppModule)
app.useWebSocketAdapter(new WsAdapter(app))
await app.listen(3001)


ApiGatewayLinker.broadcast('Service API', 3001)