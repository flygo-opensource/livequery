export const PORT = Number(process.env.PORT ?? 8082)

/** A replica set is required: change streams do not exist on a standalone mongod. */
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0'

export const DB_NAME = process.env.DB_NAME ?? 'livequery_examples'

export const COLLECTION = process.env.COLLECTION ?? 'todos'
