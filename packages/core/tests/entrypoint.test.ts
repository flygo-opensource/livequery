import { describe, expect, test } from 'bun:test'
import {
    ApiGatewayHandler,
    ApiServiceLinker,
    hidePrivateFields,
    LivequeryRequestParser,
    UdpDiscovery,
    WebsocketGateway,
    WEBSOCKET_PATH,
} from '../src/index.js'

describe('package entrypoint', () => {
    test('exports the public runtime API', () => {
        expect(typeof ApiGatewayHandler).toBe('function')
        expect(typeof ApiServiceLinker).toBe('function')
        expect(typeof LivequeryRequestParser).toBe('function')
        expect(typeof UdpDiscovery).toBe('function')
        expect(typeof WebsocketGateway).toBe('function')
        expect(typeof hidePrivateFields).toBe('function')
        expect(WEBSOCKET_PATH).toBe('/livequery/realtime-updates')
    })
})
