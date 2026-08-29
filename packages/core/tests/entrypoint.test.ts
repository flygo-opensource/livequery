import { describe, expect, test } from 'bun:test'
import { UdpDiscovery as SharedUdpDiscovery } from '@ohayo/udp'
import {
    ApiGatewayHandler,
    ApiServiceLinker,
    hidePrivateFields,
    HttpDiscovery,
    LivequeryRequestParser,
    UdpDiscovery,
    WebsocketGateway,
    WEBSOCKET_PATH,
} from '../src/index.js'

describe('package entrypoint', () => {
    test('exports the public runtime API', () => {
        expect(typeof ApiGatewayHandler).toBe('function')
        expect(typeof ApiServiceLinker).toBe('function')
        expect(typeof HttpDiscovery).toBe('function')
        expect(typeof LivequeryRequestParser).toBe('function')
        expect(typeof LivequeryRequestParser.parse).toBe('function')
        expect(typeof UdpDiscovery).toBe('function')
        expect(UdpDiscovery).toBe(SharedUdpDiscovery)
        expect(typeof WebsocketGateway).toBe('function')
        expect(typeof hidePrivateFields).toBe('function')
        expect(WEBSOCKET_PATH).toBe('/livequery/realtime-updates')
    })
})
