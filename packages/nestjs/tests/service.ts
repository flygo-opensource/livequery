import { NestFactory } from "@nestjs/core";
import { LivequeryWebsocketSync } from "../src/LivequeryWebsocketSync.js";
import { WsAdapter } from '@nestjs/platform-ws'
import { UseLivequeryInterceptor } from "../src/LivequeryInterceptor.js";
import { ApiGatewayLinker, ObservableResponse } from "../src/index.js";
import { Controller, Get, Module } from "@nestjs/common";
import { finalize, interval, map } from "rxjs";
import { WebsocketSyncPayload } from "@livequery/types";



@Controller('livequery/pets')
export class PetCollection {


    @Get()
    @UseLivequeryInterceptor()
    list() {
        console.log('Activated')
        return new ObservableResponse(ctx => {
            return {
                first: {
                    items: [
                        {
                            id: '123',
                            name: 'ijiji'
                        }
                    ]
                },
                observable: interval(1000).pipe(
                    map((_, i) => {
                        const e: WebsocketSyncPayload<{ id: string, length: number }> = {
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
                        }
                        return e
                    }),
                    finalize(() => {
                        console.log(`User cancel hahaha`)
                    })
                )
            }
        })
        // return {
        //     items: [
        //         {
        //             id: '123',
        //             legnth: 0
        //         }
        //     ]
        // }
    }
}


@Module({
    controllers: [ApiGatewayLinker, PetCollection],
    providers: [LivequeryWebsocketSync]
})
export class AppModule { }

const app = await NestFactory.create(AppModule)
app.useWebSocketAdapter(new WsAdapter(app))
await app.listen(3003)


ApiGatewayLinker.broadcast('Service API', 3003)