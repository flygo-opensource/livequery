import { Inject, Provider } from "@nestjs/common"


const WebsocketPublicKey = 'WebsocketPublicKey'
const WebsocketPrivateKey = 'WebsocketPrivateKey'

export const InjectWebsocketPublicKey = () => Inject(WebsocketPublicKey)
export const InjectWebsocketPrivateKey = () => Inject(WebsocketPrivateKey)


export const UseWebsocketPublicKey = (secret_or_public_key: string) => ({
    provide: WebsocketPublicKey,
    useFactory: () => secret_or_public_key
} as Provider)


export const UseWebsocketPrivateKey = (secret_or_private_key: string) => ({
    provide: WebsocketPrivateKey,
    useFactory: () => secret_or_private_key
} as Provider)