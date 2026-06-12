// Same as fb-basic-probe.ts but with account-kit imports added
import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import { generatePrivateKey } from 'viem/accounts'
import { keccak256, toHex } from 'viem'

const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
let msgs = 0

const ws = new WebSocket(WS_URL)
ws.onopen = () => { console.log('OPEN'); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] })) }
ws.onmessage = () => msgs++
ws.onerror = (e) => console.log('ERROR', e)

await new Promise(r => setTimeout(r, 3_000))
console.log(`msgs after 3s: ${msgs}`)
ws.close()
process.exit(0)
