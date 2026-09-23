/// <reference lib="webworker" />
import { SharedWorkerChannel, WorkerManager } from '@livequery/rpc'
import { TodoService } from './TodoService'

// One instance for every tab that connects to this SharedWorker.
new WorkerManager(new SharedWorkerChannel()).exposeService('todos', new TodoService(self.location.origin))
