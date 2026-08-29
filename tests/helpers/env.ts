export const MONGO_URL = process.env.LIVEQUERY_E2E_MONGO_URL
    ?? 'mongodb://127.0.0.1:27017'

export const DB_NAME = process.env.LIVEQUERY_E2E_DB_NAME ?? 'livequery'

export const AUTH_SOURCE = process.env.LIVEQUERY_E2E_AUTH_SOURCE ?? 'admin'
