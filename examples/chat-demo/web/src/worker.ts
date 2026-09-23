/// <reference lib="webworker" />
import { SharedWorkerChannel, WorkerManager } from '@livequery/rpc'
import { ChatService } from './ChatService'

// One ChatService for every tab — and every signed-in account — of this browser.
new WorkerManager(new SharedWorkerChannel()).exposeService('chat', new ChatService(self.location.origin))
