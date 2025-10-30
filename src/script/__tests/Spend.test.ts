import PrivateKey from '../../primitives/PrivateKey'
import { hash160, hash256 } from '../../primitives/Hash'
import Curve from '../../primitives/Curve'
import Spend from '../../script/Spend'
import P2PKH from '../../script/templates/P2PKH'
import RPuzzle from '../../script/templates/RPuzzle'
import Transaction from '../../transaction/Transaction'
import LockingScript from '../../script/LockingScript'
import UnlockingScript from '../../script/UnlockingScript'
import MerklePath from '../../transaction/MerklePath'
import ChainTracker from '../../transaction/ChainTracker'
import spendValid from './spend.valid.vectors'
import Script from '../../script/Script'

export class MockChain implements ChainTracker {
  mock: { blockheaders: string[] }

  constructor(mock: { blockheaders: string[] }) {
    this.mock = mock
  }

  addBlock(merkleRoot: string) {
    this.mock.blockheaders.push(merkleRoot)
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    return this.mock.blockheaders[height] === root
  }

  async currentHeight(): Promise<number> {
    return this.mock.blockheaders.length
  }
}

describe('Spend', () => {
  it('Successfully validates a P2PKH spend', async () => {
    const privateKey = new PrivateKey(1)
    const publicKey = privateKey.toPublicKey()
    const hash = publicKey.toHash()
    const p2pkh = new P2PKH()
    const lockingScript = p2pkh.lock(hash)
    const satoshis = 1
    const unlockingTemplate = p2pkh.unlock(privateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )
    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )
    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })
    const valid = spend.validate()
    expect(valid).toBe(true)
  })
  it('Fails to verify a P2PKH spend with the wrong key', async () => {
    const privateKey = new PrivateKey(1)
    const publicKey = privateKey.toPublicKey()
    const wrongPrivateKey = new PrivateKey(2)
    const hash = publicKey.toHash()
    const p2pkh = new P2PKH()
    const lockingScript = p2pkh.lock(hash)
    const satoshis = 1
    const unlockingTemplate = p2pkh.unlock(wrongPrivateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )
    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )
    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })
    expect(() => spend.validate()).toThrow()
  })
  it('Successfully validates an R-puzzle spend', async () => {
    const k = new PrivateKey(2)
    const c = new Curve()
    let r = c.g.mul(k).x?.umod(c.n)?.toArray()
    if (r !== null && r !== undefined) {
      r = r[0] > 127 ? [0, ...r] : r
    }

    const puz = new RPuzzle()
    const lockingScript = puz.lock(r ?? [])
    const satoshis = 1

    // ✅ Fix: Ensure privateKey is valid and within range
    const privateKey = PrivateKey.fromRandom()

    const unlockingTemplate = puz.unlock(k, privateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )

    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )

    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })

    const valid = spend.validate()
    expect(valid).toBe(true)
  })

  it('Successfully validates an R-puzzle spend (HASH256)', async () => {
    const k = new PrivateKey(2)
    const c = new Curve()
    let r = c.g.mul(k).x?.umod(c.n)?.toArray()
    if (r !== null && r !== undefined) {
      r = r[0] > 127 ? [0, ...r] : r
      r = hash256(r)
    }
    const puz = new RPuzzle('HASH256')
    const lockingScript = puz.lock(r ?? [])
    const satoshis = 1

    // ✅ Fix: Ensure privateKey is valid and within range
    const privateKey = PrivateKey.fromRandom()

    const unlockingTemplate = puz.unlock(k, privateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )

    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )

    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })

    const valid = spend.validate()
    expect(valid).toBe(true)
  })

  it('Fails to validate an R-puzzle spend with the wrong K value', async () => {
    const k = new PrivateKey(2)
    const wrongK = new PrivateKey(5)
    const c = new Curve()
    let r = c.g.mul(k).x?.umod(c.n)?.toArray()
    if (r !== null && r !== undefined) {
      r = r[0] > 127 ? [0, ...r] : r
      r = hash256(r)
    }
    const puz = new RPuzzle('HASH256')
    const lockingScript = puz.lock(r ?? [])
    const satoshis = 1

    // ✅ Fix: Ensure privateKey is valid and within range
    const privateKey = PrivateKey.fromRandom()

    const unlockingTemplate = puz.unlock(wrongK, privateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )

    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )

    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })

    expect(() => spend.validate()).toThrow()
  })

  it('Fails to validate an R-puzzle spend with the wrong hash', async () => {
    const k = new PrivateKey(2)
    const c = new Curve()
    let r = c.g.mul(k).x?.umod(c.n)?.toArray()
    if (r !== null && r !== undefined) {
      r = r[0] > 127 ? [0, ...r] : r
      r = hash160(r)
    }
    const puz = new RPuzzle('HASH256')
    const lockingScript = puz.lock(r ?? [])
    const satoshis = 1

    // ✅ Fix: Ensure privateKey is valid and within range
    const privateKey = PrivateKey.fromRandom()

    const unlockingTemplate = puz.unlock(k, privateKey)
    const sourceTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript,
          satoshis
        }
      ],
      0
    )

    const spendTx = new Transaction(
      1,
      [
        {
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )

    const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })

    expect(() => spend.validate()).toThrow()
  })
  for (let i = 0; i < spendValid.length; i++) {
    const a = spendValid[i]
    if (a.length === 1) {
      continue
    }
    it(a[2], () => {
      const spend = new Spend({
        sourceTXID:
          '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        lockingScript: LockingScript.fromHex(a[1]),
        transactionVersion: 1,
        otherInputs: [],
        outputs: [],
        inputIndex: 0,
        unlockingScript: UnlockingScript.fromHex(a[0]),
        inputSequence: 0xffffffff,
        lockTime: 0
      })
      expect(spend.validate()).toBe(true)
    })
  }

  it('Successfully validates a spend where sequence is set to undefined', async () => {
    const sourceTransaction = new Transaction(
      1,
      [{
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE'),
        sequence: 0xffffffff
      }],
      [
        {
          lockingScript: Script.fromASM('OP_NOP'),
          satoshis: 2
        }
      ],
      0
    )
    const txid = sourceTransaction.id('hex')
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(txid, 0)
    const chain = new MockChain({ blockheaders: [] })
    chain.addBlock(txid)

    const spendTx = new Transaction(
      1,
      [
        {
          unlockingScript: Script.fromASM('OP_TRUE'),
          sourceTransaction,
          sourceOutputIndex: 0
        }
      ],
      [{
          lockingScript: Script.fromASM('OP_NOP'),
          satoshis: 1
      }],
      0
    )

    const valid = await spendTx.verify(chain)
    
    expect(valid).toBe(true)

    const b = spendTx.toBinary()
    const t = Transaction.fromBinary(b)
    expect(t.inputs[0].sequence).toBe(0xffffffff)

    const b2 = spendTx.toEF()
    const t2 = Transaction.fromEF(b2)
    expect(t2.inputs[0].sequence).toBe(0xffffffff)
  })
})
