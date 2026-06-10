import { describe, expect, it } from 'bun:test'
import { LivequeryRequestParser, type LivequeryContext } from '../src/index.js'

const AUTOSHOPEE_LIVEQUERY_ROUTES = [
    "livequery/locales/:locale/packages",
    "livequery/packages",
    "livequery/realtime-probe/:id",
    "livequery/refs/:ref/spaces",
    "livequery/refs/:ref/spaces/:id",
    "livequery/spaces",
    "livequery/spaces/:id",
    "livequery/spaces/:id/~cancel-delete",
    "livequery/spaces/:id/~schedule-delete",
    "livequery/spaces/:space_id/account_id/:account_uid/ads",
    "livequery/spaces/:space_id/account_id/:account_uid/ads/:id",
    "livequery/spaces/:space_id/accounts",
    "livequery/spaces/:space_id/accounts/:account_id/~sync-account-ads",
    "livequery/spaces/:space_id/accounts/:account_id/~sync-account-income",
    "livequery/spaces/:space_id/accounts/:account_id/~sync-account-sales",
    "livequery/spaces/:space_id/accounts/:account_uid/autocoin-nodes",
    "livequery/spaces/:space_id/accounts/:account_uid/autocoin-nodes/:id",
    "livequery/spaces/:space_id/accounts/:account_uid/automation-nodes",
    "livequery/spaces/:space_id/accounts/:account_uid/automation-nodes/:id",
    "livequery/spaces/:space_id/accounts/:account_uid/campaigns",
    "livequery/spaces/:space_id/accounts/:account_uid/charts",
    "livequery/spaces/:space_id/accounts/:account_uid/details/summary",
    "livequery/spaces/:space_id/accounts/:account_uid/restreams/:id/~stop",
    "livequery/spaces/:space_id/accounts/:account_uid/saved-configs",
    "livequery/spaces/:space_id/accounts/:account_uid/saved-configs/:id",
    "livequery/spaces/:space_id/accounts/:account_uid/~campaigns",
    "livequery/spaces/:space_id/accounts/:account_uid/~chart",
    "livequery/spaces/:space_id/accounts/:account_uid/~restream",
    "livequery/spaces/:space_id/accounts/:account_uid/~summary",
    "livequery/spaces/:space_id/accounts/:creator_uid/livestreams",
    "livequery/spaces/:space_id/accounts/:creator_uid/livestreams/:id",
    "livequery/spaces/:space_id/accounts/:creator_uid/livestreams/:type/list",
    "livequery/spaces/:space_id/accounts/:id",
    "livequery/spaces/:space_id/accounts/:id/~sync-account-live-status",
    "livequery/spaces/:space_id/accounts/:shop_uid/new-sales",
    "livequery/spaces/:space_id/accounts/~extension-account-sync",
    "livequery/spaces/:space_id/accounts/~import",
    "livequery/spaces/:space_id/accounts/~sync-account-ads",
    "livequery/spaces/:space_id/accounts/~sync-account-income",
    "livequery/spaces/:space_id/accounts/~sync-account-sales",
    "livequery/spaces/:space_id/ads",
    "livequery/spaces/:space_id/ads/:id",
    "livequery/spaces/:space_id/apps",
    "livequery/spaces/:space_id/apps/:id",
    "livequery/spaces/:space_id/apps/~install",
    "livequery/spaces/:space_id/autocoin-nodes/:id",
    "livequery/spaces/:space_id/autocoin-nodes/:id/~duplicate",
    "livequery/spaces/:space_id/autocoin-nodes/:id/~run-once",
    "livequery/spaces/:space_id/autocoin-nodes/:id/~toggle",
    "livequery/spaces/:space_id/autocoin-nodes/:node_id/autocoin-logs",
    "livequery/spaces/:space_id/autocoin-nodes/:node_id/autocoin-logs/:id",
    "livequery/spaces/:space_id/automation-nodes/:id",
    "livequery/spaces/:space_id/automation-nodes/:id/~duplicate",
    "livequery/spaces/:space_id/automation-nodes/:id/~refresh-meta",
    "livequery/spaces/:space_id/automation-nodes/:id/~refresh-stats",
    "livequery/spaces/:space_id/automation-nodes/:id/~toggle",
    "livequery/spaces/:space_id/automation-nodes/:node_id/budget-logs",
    "livequery/spaces/:space_id/automation-nodes/:node_id/budget-logs/:id",
    "livequery/spaces/:space_id/livestreams",
    "livequery/spaces/:space_id/livestreams/:id",
    "livequery/spaces/:space_id/livestreams/:type/list",
    "livequery/spaces/:space_id/new-accounts/:id",
    "livequery/spaces/:space_id/new-sales",
    "livequery/spaces/:space_id/notify-channels",
    "livequery/spaces/:space_id/notify-channels/:id",
    "livequery/spaces/:space_id/notify-channels/:id/~revoke-line-notify",
    "livequery/spaces/:space_id/notify-channels/:id/~simple-test-line-notify",
    "livequery/spaces/:space_id/notify-channels/:id/~test-line-notify",
    "livequery/spaces/:space_id/notify-channels/:id/~test-telegram",
    "livequery/spaces/:space_id/notify-channels/~create-line-notify",
    "livequery/spaces/:space_id/packages/:id/~buy",
    "livequery/spaces/:space_id/packages/:id/~check-voucher",
    "livequery/spaces/:space_id/payouts",
    "livequery/spaces/:space_id/payouts/:account_uid/details",
    "livequery/spaces/:space_id/payouts/:account_uid/validations/:id",
    "livequery/spaces/:space_id/payouts/:account_uid/validations/:id/~download",
    "livequery/spaces/:space_id/payouts/:id",
    "livequery/spaces/:space_id/permissions",
    "livequery/spaces/:space_id/permissions/:id",
    "livequery/spaces/:space_id/restreams/:id/~stop",
    "livequery/spaces/:space_id/saved-configs/:id",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists/:id",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists/:id/~pull-livestreams",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists/:id/~pull-products",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists/:id/~push-products",
    "livequery/spaces/:space_id/tools/livestream-product-manager/lists/:list_id/tasks/:id",
    "livequery/spaces/:space_id/transactions",
    "livequery/spaces/:space_id/transactions/:id",
    "livequery/spaces/:space_id/~admin-add-fund",
    "livequery/spaces/:space_id/~affiliate-add-fund",
    "livequery/spaces/:space_id/~generate-24social-cash-url",
    "livequery/spaces/:space_id/~generate-24social-corporate-url",
    "livequery/spaces/:space_id/~generate-24social-individual-url",
    "livequery/spaces/:space_id/~generate-chillpay-url",
    "livequery/spaces/:space_id/~restream",
    "livequery/spaces/:target/types/:type/tasks",
    "livequery/spaces/:target/types/:type/tasks/:id",
    "livequery/tool-livestream-products/:space_id/product-lists",
    "livequery/tool-livestream-products/:space_id/product-lists/:id",
    "livequery/tool-livestream-products/:space_id/product-lists/:id/~pull-livestreams",
    "livequery/tool-livestream-products/:space_id/product-lists/:id/~pull-products",
    "livequery/tool-livestream-products/:space_id/product-lists/:id/~push-products",
    "livequery/tool-livestream-products/:space_id/product-lists/:list_id/tasks/:id",
    "livequery/tool-pin-check/:space_id/lists",
    "livequery/tool-pin-check/:space_id/lists/:id",
    "livequery/tool-pin-check/:space_id/lists/:id/~check-pdp",
    "livequery/tool-pin-check/:space_id/lists/:id/~get-pdp-price",
    "livequery/tool-pin-check/:space_id/lists/:id/~reload-products",
    "livequery/tool-pin-check/:space_id/lists/:id/~stop-pdp-check",
    "livequery/tool-pin-check/:space_id/lists/:list_id/products",
    "livequery/tool-pin-check/:space_id/lists/:list_id/products/:id",
    "livequery/tool-pin-check/:space_id/lists/~create",
    "livequery/tool-pin-check/:space_id/products/:id/livestreams/:id",
    "livequery/tool-pin-check/~add-cookies",
    "livequery/transactions",
    "livequery/transactions/:id",
    "livequery/types/:type/transactions",
    "livequery/types/:type/transactions/:id",
    "livequery/users",
    "livequery/users/:id",
    "livequery/users/:id/~oidc-link",
    "livequery/users/:id/~oidc-unlink",
    "livequery/users/:uids/spaces",
    "livequery/users/:uids/spaces/:space_id/~auth",
    "livequery/users/:user_id/checked-livestreams",
    "livequery/users/:user_id/checked-livestreams/:id",
    "livequery/users/:user_id/checked-livestreams/:id/~check",
    "livequery/users/:user_id/checked-livestreams/~check",
    "livequery/users/:user_id/mfas",
    "livequery/users/:user_id/mfas/:id",
    "livequery/users/:user_id/notify-channels",
    "livequery/users/:user_id/notify-channels/:id",
    "livequery/users/:user_id/notify-channels/:id/~revoke-line-notify",
    "livequery/users/:user_id/notify-channels/:id/~simple-test-line-notify",
    "livequery/users/:user_id/notify-channels/:id/~test-line-notify",
    "livequery/users/:user_id/notify-channels/:id/~test-telegram",
    "livequery/users/:user_id/notify-channels/~create-line-notify",
    "livequery/users/:user_id/notify-channels/~create-telegram-notify",
    "livequery/users/:user_id/passkeys",
    "livequery/users/:user_id/passkeys/:id",
    "livequery/users/:user_id/telegram-notify-channels",
    "livequery/users/:user_id/~generate-registration-options",
    "livequery/users/:user_id/~generate-totp-secret",
    "livequery/users/:user_id/~logout",
    "livequery/users/:user_id/~register-mfa-totp",
    "livequery/users/:user_id/~register-passkey",
    "livequery/users/:user_id/~verify-mfa-totp",
    "livequery/users/:user_uid/transactions",
    "livequery/users/:user_uid/transactions/:id",
    "livequery/users/:user_uid/types/:type/transactions",
    "livequery/users/~generate-passkey-auth-options",
    "livequery/users/~oidc-login",
    "livequery/users/~passkey-login",
    "livequery/users/~refresh",
    "livequery/vouchers",
    "livequery/vouchers/:id",
    "livequery/vouchers/:id/~enable",
    "livequery/vouchers/:id/~pause",
] as const

describe('LivequeryRequestParser with AutoShopee server routes', () => {
    it('parses every scanned AutoShopee Livequery route without losing static/dynamic boundaries', () => {
        expect(AUTOSHOPEE_LIVEQUERY_ROUTES).toHaveLength(159)

        for (const route of AUTOSHOPEE_LIVEQUERY_ROUTES) {
            const { ctx, expected } = createRouteContext(route)

            new LivequeryRequestParser().handle(ctx)

            expect(ctx.livequery, route).toBeDefined()
            expect(ctx.livequery?.ref, route).toBe(expected.ref)
            expect(ctx.livequery?.collection_ref, route).toBe(expected.collection_ref)
            expect(ctx.livequery?.collection, route).toBe(expected.collection)
            expect(ctx.livequery?.schema, route).toBe(expected.schema)
            expect(ctx.livequery?.schema_collection_ref, route).toBe(expected.schema_collection_ref)
            expect(ctx.livequery?.document_id, route).toBe(expected.document_id)
            expect(ctx.livequery?.action, route).toBe(expected.action)
            expect(ctx.livequery?.keys, route).toEqual(expected.keys)
        }
    })
})

function createRouteContext(route: string): {
    ctx: LivequeryContext
    expected: {
        ref: string
        collection_ref: string
        collection: string
        schema: string
        schema_collection_ref: string
        document_id?: string
        action?: string
        keys: Record<string, string>
    }
} {
    const params = routeParams(route)
    const path = materializePath(route, params)
    const routeSegments = routePath(route).split('/').filter(Boolean)
    const pathSegments = routePath(path).split('/').filter(Boolean)
    const document_id = routeSegments[routeSegments.length - 1]?.startsWith(':') ? pathSegments[routeSegments.length - 1] : undefined
    const ref = pathSegments.slice(1).join('/')
    const collection_ref = pathSegments.slice(1, document_id ? pathSegments.length - 1 : undefined).join('/')
    const schemaSegments = routeSegments.slice(1, document_id ? routeSegments.length - 1 : undefined)
    const schema = schemaSegments.join('/')
    const schema_collection_ref = schemaSegments.map(segment => segment.startsWith(':') ? segment.slice(1) : segment).join('/')
    const collection = collection_ref.split('/').pop() || ''
    const keys = Object.fromEntries(
        routeSegments
            .filter(segment => segment.startsWith(':'))
            .map(segment => segment.slice(1))
            .filter((key, index, list) => list.indexOf(key) === index)
            .map(key => [key, params[key]])
    )

    return {
        ctx: {
            request: {
                path,
                ref: route,
                method: route.includes('~') ? 'POST' : 'GET',
                params,
                query: {},
                headers: new Map(),
            },
        },
        expected: {
            ref,
            collection_ref,
            collection,
            schema,
            schema_collection_ref,
            document_id,
            action: actionOf(path),
            keys,
        },
    }
}

function routeParams(route: string): Record<string, string> {
    return Object.fromEntries(
        routePath(route).split('/').filter(segment => segment.startsWith(':')).map(segment => {
            const key = segment.slice(1)
            return [key, `${key}_value`]
        })
    )
}

function materializePath(route: string, params: Record<string, string>) {
    return route.split('/').map(segment => segment.startsWith(':') ? params[segment.slice(1)] : segment).join('/')
}

function routePath(path: string) {
    return path.split('?')[0].split('~')[0]
}

function actionOf(path: string) {
    const pathname = path.split('?')[0]
    const index = pathname.indexOf('~')
    if (index === -1) return undefined
    return pathname.slice(index + 1).replace(/\/+$/, '') || undefined
}
