import { describe, expect, test } from "bun:test"
import { serializeError } from "../src/WorkerManager.js"

describe("serializeError — primitives & non-object inputs", () => {
    test("string → InternalError with the string as message", () => {
        expect(serializeError("boom")).toEqual({ code: "InternalError", message: "boom" })
    })
    test("empty string is preserved as message", () => {
        expect(serializeError("")).toEqual({ code: "InternalError", message: "" })
    })
    test("null → message 'null'", () => {
        expect(serializeError(null)).toEqual({ code: "InternalError", message: "null" })
    })
    test("undefined → message 'undefined'", () => {
        expect(serializeError(undefined)).toEqual({ code: "InternalError", message: "undefined" })
    })
    test("number → stringified message", () => {
        expect(serializeError(42)).toEqual({ code: "InternalError", message: "42" })
    })
    test("zero (falsy number) still stringifies", () => {
        expect(serializeError(0)).toEqual({ code: "InternalError", message: "0" })
    })
    test("NaN → 'NaN'", () => {
        expect(serializeError(NaN)).toEqual({ code: "InternalError", message: "NaN" })
    })
    test("boolean true/false", () => {
        expect(serializeError(true)).toEqual({ code: "InternalError", message: "true" })
        expect(serializeError(false)).toEqual({ code: "InternalError", message: "false" })
    })
})

describe("serializeError — Error instances", () => {
    test("Error → code from name, message preserved, stack is a string", () => {
        const r = serializeError(new Error("boom"))
        expect(r.code).toBe("Error")
        expect(r.message).toBe("boom")
        expect(typeof r.stack).toBe("string")
        expect(r.stack!.length).toBeGreaterThan(0)
    })
    test("subclass uses its constructor name as code", () => {
        const r = serializeError(new TypeError("bad type"))
        expect(r.code).toBe("TypeError")
        expect(r.message).toBe("bad type")
    })
    test("explicit .code wins over .name", () => {
        const e = new Error("conn refused") as any
        e.code = "ECONNREFUSED"
        expect(serializeError(e).code).toBe("ECONNREFUSED")
    })
    test("Error with EMPTY message → falls back to code, never '[object Object]'", () => {
        // The original bug: empty message → String(obj) → "[object Object]".
        const r = serializeError(new Error(""))
        expect(r.message).not.toBe("[object Object]")
        expect(r.message).toBe("Error") // JSON of an Error is '{}' → returns code
        expect(r.code).toBe("Error")
    })
    test("custom Error subclass with code + empty message surfaces the code", () => {
        class DomainError extends Error {
            code = "E_DOMAIN"
            constructor() { super("") }
        }
        const r = serializeError(new DomainError())
        expect(r.code).toBe("E_DOMAIN")
        expect(r.message).not.toBe("[object Object]")
    })
})

describe("serializeError — plain objects (code/name/message resolution)", () => {
    test("full shape passes through", () => {
        expect(serializeError({ code: "E1", message: "msg" }))
            .toEqual({ code: "E1", message: "msg", stack: undefined })
    })
    test("name used when no code", () => {
        expect(serializeError({ name: "MyErr", message: "m" }).code).toBe("MyErr")
    })
    test("numeric code is stringified", () => {
        expect(serializeError({ code: 500, message: "m" }).code).toBe("500")
    })
    test("no code/name → InternalError", () => {
        expect(serializeError({ message: "m" }).code).toBe("InternalError")
    })
    test("missing message → JSON of own enumerable props", () => {
        expect(serializeError({ code: "E2" }).message).toBe('{"code":"E2"}')
    })
    test("non-string message → fallback to JSON", () => {
        const r = serializeError({ message: 123 } as any)
        expect(r.message).toBe('{"message":123}')
    })
    test("empty message but other fields → surfaces real fields as JSON (not [object Object])", () => {
        const r = serializeError({ code: "E", message: "" })
        expect(r.message).not.toBe("[object Object]")
        expect(r.message).toBe('{"code":"E","message":""}')
        expect(r.code).toBe("E")
    })
})

describe("serializeError — empty/bare objects & arrays", () => {
    test("empty object {} → message equals code (JSON is '{}')", () => {
        expect(serializeError({})).toEqual({ code: "InternalError", message: "InternalError", stack: undefined })
    })
    test("object with only non-error fields → JSON message", () => {
        expect(serializeError({ foo: "bar" }).message).toBe('{"foo":"bar"}')
    })
    test("empty array [] → message equals code (JSON is '[]')", () => {
        expect(serializeError([])).toEqual({ code: "InternalError", message: "InternalError", stack: undefined })
    })
    test("non-empty array → JSON message", () => {
        expect(serializeError([1, 2, 3]).message).toBe("[1,2,3]")
    })
})

describe("serializeError — JSON.stringify throwing (circular / bad toJSON)", () => {
    test("circular reference falls back to code", () => {
        const c: any = { code: "E_CIRC" }
        c.self = c
        const r = serializeError(c)
        expect(r.code).toBe("E_CIRC")
        expect(r.message).toBe("E_CIRC")
    })
    test("circular with no code/name falls back to InternalError", () => {
        const c: any = {}
        c.self = c
        expect(serializeError(c)).toEqual({ code: "InternalError", message: "InternalError", stack: undefined })
    })
    test("toJSON that throws is caught → falls back to code", () => {
        const e = { code: "E_TOJSON", toJSON() { throw new Error("nope") } }
        expect(serializeError(e).message).toBe("E_TOJSON")
    })
    test("BigInt (JSON.stringify throws TypeError) falls back to code", () => {
        const e = { code: "E_BIG", big: BigInt(10) } as any
        expect(serializeError(e).message).toBe("E_BIG")
    })
})

describe("serializeError — stack handling", () => {
    test("string stack is preserved", () => {
        expect(serializeError({ code: "E", message: "m", stack: "at foo()" }).stack).toBe("at foo()")
    })
    test("non-string stack → undefined", () => {
        expect(serializeError({ code: "E", message: "m", stack: 123 } as any).stack).toBeUndefined()
    })
    test("plain object without stack → undefined", () => {
        expect(serializeError({ code: "E", message: "m" }).stack).toBeUndefined()
    })
})

describe("serializeError — output is always a wire-safe plain object", () => {
    test("Error instance → plain object, structuredClone-safe (postMessage won't throw)", () => {
        const r = serializeError(new Error("x"))
        expect(Object.getPrototypeOf(r)).toBe(Object.prototype) // not an Error instance
        expect(() => structuredClone(r)).not.toThrow()
    })
    test("null-prototype object input still serializes", () => {
        const o = Object.create(null)
        o.code = "E_NP"
        o.message = "np"
        expect(serializeError(o)).toEqual({ code: "E_NP", message: "np", stack: undefined })
    })
    test("frozen object input is handled", () => {
        const r = serializeError(Object.freeze({ code: "E", message: "m" }))
        expect(r).toEqual({ code: "E", message: "m", stack: undefined })
    })
    test("every result has string code and string message", () => {
        for (const input of ["s", "", 1, 0, true, false, null, undefined, {}, [], new Error("e"), { code: "x" }, { message: "y" }]) {
            const r = serializeError(input as any)
            expect(typeof r.code).toBe("string")
            expect(typeof r.message).toBe("string")
        }
    })
})
