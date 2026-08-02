import { runStoreContractTests } from './store-contract.ts'
import { MemoryStore } from '#domain-model'

runStoreContractTests('MemoryStore', async () => new MemoryStore())
