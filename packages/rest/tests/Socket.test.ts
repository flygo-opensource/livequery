import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decode, encode } from "@msgpack/msgpack";
import { firstValueFrom } from "rxjs";
import { LIVEQUERY_PING_FRAME, Socket } from "../src/Socket.js";

const originalWebSocket = globalThis.WebSocket;

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

class FakeMessageEvent extends Event {
    constructor(public data: string | ArrayBuffer | Uint8Array) {
        super("message");
    }
}

class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = [];

    binaryType: BinaryType = "blob";
    sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

    constructor(public url: string) {
        super();
        FakeWebSocket.instances.push(this);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        this.sent.push(data);
    }

    close() {
        // Tests close sockets explicitly through Socket.stop().
    }

    drop() {
        this.dispatchEvent(new Event("close"));
    }

    open() {
        this.dispatchEvent(new Event("open"));
    }

    message(data: string | ArrayBuffer | Uint8Array) {
        this.dispatchEvent(new FakeMessageEvent(data));
    }
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as any;
});

afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
});

describe("Socket", () => {
    test("the keep-alive frame is the canonical JSON encoding, sent as a raw string", () => {
        // A Cloudflare Durable Object answers this frame in the runtime, matching it as an exact
        // string — so it must never go through the msgpack encoder, and no field may be added.
        expect(LIVEQUERY_PING_FRAME).toBe(JSON.stringify({ event: "ping" }));
        expect(typeof LIVEQUERY_PING_FRAME).toBe("string");
    });

    test("dispatches JSON hello messages", async () => {
        const socket = new Socket("wss://api.example.com/ws");
        await tick();

        const ws = FakeWebSocket.instances[0];
        ws.open();
        ws.message(JSON.stringify({ event: "hello", gid: "gateway-json" }));

        await expect(firstValueFrom(socket.$gateway)).resolves.toBe("gateway-json");
        expect(socket.value.connected).toBe(true);
        expect(ws.binaryType).toBe("arraybuffer");

        socket.stop();
    });

    test("dispatches MessagePack sync messages", async () => {
        const socket = new Socket("wss://api.example.com/ws");
        const change$ = firstValueFrom(socket.listen("todos"));
        await tick();

        const ws = FakeWebSocket.instances[0];
        ws.open();
        ws.message(encode({
            event: "sync",
            data: {
                changes: [
                    {
                        ref: "todos",
                        id: "todo-1",
                        type: "modified",
                        data: { title: "Updated" }
                    }
                ]
            }
        }));

        await expect(change$).resolves.toMatchObject({
            collection_ref: "todos",
            id: "todo-1",
            type: "modified",
            data: { title: "Updated" }
        });

        socket.stop();
    });

    test("sends outbound messages as MessagePack after binary hello", async () => {
        const socket = new Socket("wss://api.example.com/ws");
        await tick();

        const ws = FakeWebSocket.instances[0];
        ws.open();
        expect(typeof ws.sent[0]).toBe("string");

        ws.message(JSON.stringify({ event: "hello", gid: "gateway-binary", binary: true }));
        socket.subscribeWith("rt-1");
        await tick();

        const subscribeMessage = ws.sent.at(-1);
        expect(typeof subscribeMessage).not.toBe("string");
        expect(decode(subscribeMessage as Uint8Array)).toEqual({
            event: "subscribe",
            data: { realtime_token: "rt-1" }
        });

        socket.stop();
    });

    test("a connection that opened resets the reconnect backoff", async () => {
        const socket = new Socket("ws://example.test/realtime");
        const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        // Three drops in a row, each after the connection had opened: every retry waits the
        // first delay (2s), not 2s, 4s, 8s…
        for (let drop = 1; drop <= 3; drop++) {
            await tick();
            const ws = FakeWebSocket.instances.at(-1)!;
            ws.open();
            ws.drop();
            const started = Date.now();
            while (FakeWebSocket.instances.length === drop) await wait(50);
            expect(Date.now() - started).toBeLessThan(3000);
        }
        socket.stop();
    }, 15000);
});
