import { Inject, Provider } from "@nestjs/common"


const WebsocketPublicKey = Symbol()
const WebsocketPrivateKey = Symbol()

export const InjectWebsocketPublicKey = () => Inject(WebsocketPublicKey)
export const InjectWebsocketPrivateKey = () => Inject(WebsocketPrivateKey)


export const UseWebsocketPublicKey = (secret_or_public_key: string) => ({
    provide: WebsocketPublicKey,
    useValue: secret_or_public_key
} as Provider)


export const UseWebsocketPrivateKey = (secret_or_private_key: string) => ({
    provide: WebsocketPublicKey,
    useValue: secret_or_private_key
} as Provider)