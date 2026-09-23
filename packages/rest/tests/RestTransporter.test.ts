import { afterEach, describe, expect, test } from "bun:test";
import { firstValueFrom } from "rxjs";
import { RestTransporter } from "../src/RestTransporter.js";

type Todo = {
    id: string
    title: string
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("RestTransporter", () => {
    test("builds normalized query URLs and forwards headers", async () => {
        const calls: Array<{ input: RequestInfo | URL, init?: RequestInit & { url?: string } }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ input, init });
            return new Response(JSON.stringify({
                data: {
                    items: [],
                    count: { current: 0, total: 0 },
                    has: {},
                    cursor: {}
                }
            }));
        }) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com/" });
        const result = await firstValueFrom(transporter.query<Todo>({
            ref: "/todos",
            filters: {
                ":limit": 10,
                "tag:in": ["work", "home"],
                ignored: undefined,
                empty: null
            } as any,
            headers: {
                Authorization: "Bearer token"
            }
        }));

        expect(calls).toHaveLength(1);
        expect(calls[0].input).toBe("https://api.example.com/todos?%3Alimit=10&tag%3Ain=work&tag%3Ain=home");
        expect(calls[0].init?.headers).toMatchObject({
            Authorization: "Bearer token"
        });
        expect(result.changes).toEqual([]);
    });

    test("encodes action names in trigger URLs", async () => {
        const calls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ input, init });
            return new Response(JSON.stringify({ data: { ok: true } }));
        }) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });
        await transporter.trigger({ ref: "todos", action: "do thing/now", payload: {} });

        expect(calls[0].input).toBe("https://api.example.com/todos/~do%20thing%2Fnow");
        expect(calls[0].init?.method).toBe("POST");
    });

    test("forwards configured credentials", async () => {
        const calls: Array<{ init?: RequestInit }> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({
                data: {
                    items: [],
                    count: { current: 0, total: 0 },
                    has: {},
                    cursor: {}
                }
            }));
        }) as typeof fetch;

        const transporter = new RestTransporter({
            api: "https://api.example.com",
            credentials: "include"
        });
        await firstValueFrom(transporter.query<Todo>({ ref: "todos" }));

        expect(calls[0].init?.credentials).toBe("include");
    });

    test("normalizes HeadersInit values returned by onRequest", async () => {
        const calls: Array<{ init?: RequestInit }> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({
                data: {
                    items: [],
                    count: { current: 0, total: 0 },
                    has: {},
                    cursor: {}
                }
            }));
        }) as typeof fetch;

        const transporter = new RestTransporter({
            api: "https://api.example.com",
            onRequest: () => ({
                headers: new Headers([
                    ["x-from-headers", "yes"]
                ])
            })
        });
        await firstValueFrom(transporter.query<Todo>({
            ref: "todos",
            headers: [["x-from-array", "yes"]]
        }));

        expect(calls[0].init?.headers).toMatchObject({
            "x-from-array": "yes",
            "x-from-headers": "yes"
        });
    });

    test("throws a structured error for non-2xx responses", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            error: { message: "short and stout" }
        }), {
            status: 418,
            statusText: "I'm a teapot"
        })) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });

        await expect(transporter.update("todos", "todo-1", { title: "Updated" })).rejects.toMatchObject({
            code: "HTTP_418",
            message: "short and stout"
        });
    });

    test("update strips client-private (underscore) fields before sending", async () => {
        const calls: Array<{ init?: RequestInit }> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({ data: { id: "todo-1" } }));
        }) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });
        await transporter.update("todos", "todo-1", { title: "Updated", _id: "x", _local: true } as any);

        const sent = JSON.parse(calls[0].init?.body as string);
        expect(sent).toEqual({ title: "Updated" });
    });

    test("update sends the version it was based on as If-Match, and nothing without one", async () => {
        const calls: Array<{ init?: RequestInit }> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({ data: { item: { id: "todo-1" } } }));
        }) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });
        await transporter.update("todos", "todo-1", { title: "A" }, undefined, { if_version: 1790000000123 });
        await transporter.update("todos", "todo-1", { title: "B" });

        expect(new Headers(calls[0].init?.headers).get("if-match")).toBe("1790000000123");
        expect(new Headers(calls[1].init?.headers).get("if-match")).toBeNull();
        expect(JSON.parse(calls[0].init?.body as string)).toEqual({ title: "A" });
    });

    test("add sends the client id but never a legacy local: one; update never sends id", async () => {
        const calls: Array<{ init?: RequestInit }> = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ init });
            return new Response(JSON.stringify({ data: { id: "todo-1", title: "x" } }));
        }) as typeof fetch;

        const id = "01890a5d-ac96-774b-bcce-b302099a8057";
        const transporter = new RestTransporter({ api: "https://api.example.com" });
        await transporter.add("todos", { id, title: "x", _adding: true } as any);
        await transporter.add("todos", { id: "local:abc", title: "x", _adding: true } as any);
        await transporter.update("todos", "todo-1", { id: "todo-1", title: "y" } as any);

        expect(JSON.parse(calls[0].init?.body as string)).toEqual({ id, title: "x" });
        expect(JSON.parse(calls[1].init?.body as string)).toEqual({ title: "x" });
        expect(JSON.parse(calls[2].init?.body as string)).toEqual({ title: "y" });
    });

    test("read() answers one page with its cursor and never subscribes to realtime", async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(JSON.stringify({ data: {
                items: [{ id: "a", title: "x" }],
                count: { current: 1, total: 3, next: 2, prev: 0 },
                has: { next: true, prev: false },
                cursor: { first: "c-first", last: "c-last" },
                subscription_token: "should-not-be-used"
            } }));
        }) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });
        const result = await transporter.read({ ref: "todos", filters: { ":limit": 1 } as any });
        expect(calls[0]).toBe("https://api.example.com/todos?%3Alimit=1");
        expect(result.changes?.map(c => c.id)).toEqual(["a"]);
        expect(result.paging?.next).toEqual({ count: 2, cursor: "c-last" });

        globalThis.fetch = (async () => { throw new TypeError("offline") }) as unknown as typeof fetch;
        const failed = await transporter.read({ ref: "todos" });
        expect(failed.error?.code).toBe("NETWORK_ERROR");
    });

    test("non-2xx errors carry the HTTP status", async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            error: { code: "INTERNAL", message: "boom" }
        }), { status: 503 })) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });

        await expect(transporter.delete("todos", "todo-1")).rejects.toMatchObject({
            code: "INTERNAL",
            status: 503
        });
    });

    test("throws InvalidJsonResponse for invalid JSON responses", async () => {
        globalThis.fetch = (async () => new Response("not json")) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });

        await expect(transporter.delete("todos", "todo-1")).rejects.toMatchObject({
            code: "InvalidJsonResponse",
            message: "InvalidJsonResponse"
        });
    });
});
