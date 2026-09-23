/// <reference lib="webworker" />
import { SharedWorkerChannel, WorkerManager } from '@livequery/rpc'
import { createClient } from './createClient'

// Every tab of this site uses this one client: one WebSocket, one outbox, one IndexedDB.
new WorkerManager(new SharedWorkerChannel()).exposeService('livequery', createClient(self.location.origin))
