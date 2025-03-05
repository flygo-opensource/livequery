import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'
import { UseLivequeryInterceptor } from "../src/LivequeryInterceptor.js";
import { ApiGatewayLinker } from "../src/index.js";
import { Controller, Get, Module } from "@nestjs/common";
import { interval, mergeAll, mergeMap } from "rxjs";
import { UpdatedData } from "@livequery/types";


type Comment = { id: string, text: string }


async function getDatabaseClient() {
    return {
        async getData(n: number) {
            const comments: Array<UpdatedData<Comment>> = [{
                data: { id: '123', text: `[${n}] Comment at ${new Date().toLocaleTimeString()}` },
                ref: 'pets',
                type: 'added'
            }]
            return comments
        }
    }
}

@Controller('livequery/pets')
export class PetCollection {

    constructor(private ws: LivequeryWebsocketSync) { }


    @Get()
    @UseLivequeryInterceptor()
    list() {
        console.log(`Pipe`)

        this.ws.pipe<Comment>('pets', async o => {

            if (o) return
            const client = await getDatabaseClient()

            return interval(2000).pipe(
                mergeMap(async n => {
                    const comments = await client.getData(n)
                    return comments
                }),
                mergeAll()
            )
        })

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