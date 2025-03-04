import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'
import { UseLivequeryInterceptor } from "../src/LivequeryInterceptor.js";
import { ApiGatewayLinker } from "../src/index.js";
import { Controller, Get, Module } from "@nestjs/common";
import { EMPTY, finalize, interval, map } from "rxjs";
import { UpdatedData, WebsocketSyncPayload } from "@livequery/types";



@Controller('livequery/pets')
export class PetCollection {

    constructor(private ws: LivequeryWebsocketSync) { }

    #n = 0

    @Get()
    @UseLivequeryInterceptor()
    list() {
        console.log(`Pipe`)
        type Comment = { id: string, text: string }
        const n = ++this.#n
        this.ws.pipe<Comment>('pets', o => interval(2000).pipe(
            map(i => {
                const e: UpdatedData<Comment> = {
                    data: { id: '123', text: `[${n}] Comment at ${new Date().toLocaleTimeString()}` },
                    ref: 'pets',
                    type: 'added'
                }
                console.log(e)
                return e
            }),
            finalize(() => console.log('All un-subscribed'))
        ))

        return {
            items: [
                {
                    id: '123',
                    name: 'ijiji'
                }
            ]
        }
    }
}


@Module({
    controllers: [ApiGatewayLinker, PetCollection],
    providers: [LivequeryWebsocketSync]
})
export class AppModule { }

const app = await NestFactory.create(AppModule)
app.useWebSocketAdapter(new WsAdapter(app))
const PORT = Number(process.argv[2] || 3000)
await app.listen(PORT)


ApiGatewayLinker.broadcast('Service API', PORT)