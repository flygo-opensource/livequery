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

    test("throws InvalidResponse for invalid JSON responses", async () => {
        globalThis.fetch = (async () => new Response("not json")) as typeof fetch;

        const transporter = new RestTransporter({ api: "https://api.example.com" });

        await expect(transporter.delete("todos", "todo-1")).rejects.toMatchObject({
            code: "InvalidResponse",
            message: "The server did not return valid JSON."
        });
    });
});
