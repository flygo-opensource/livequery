import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decode, encode } from "@msgpack/msgpack";
import { firstValueFrom } from "rxjs";
import { Socket } from "../src/Socket.js";

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
});
