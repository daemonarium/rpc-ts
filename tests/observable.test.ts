import { expect } from 'chai'

import {
  Observable,
  ObservableState,
  RingBuffer,
  type BinaryEntry,
  type Change,
  type Consumer,
  ObservablePromise,
  setConsumerFinalizerForTest,
} from '../src/index.js'
import { bytesEqual } from '../src/observable/types.js'

function b(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function expectKey(actual: Uint8Array, expected: string): void {
  expect(bytesEqual(actual, b(expected))).to.equal(true)
}

class RecordingConsumer implements Consumer {
  changes: Change[] = []
  since: bigint | number = 0
  readys = 0
  resets = 0
  errors = 0
  closeds = 0
  private alive = true

  onChange(c: Change): ObservablePromise {
    this.changes.push(c)
    return ObservablePromise.resolved()
  }
  onReady(): void { this.readys++ }
  onReset(): void {
    this.resets++
    this.changes = []
  }
  onError(_ex: unknown): void { this.errors++ }
  onClosed(): void { this.closeds++ }
  sinceTimestamp(): bigint | number { return this.since }
  isAlive(): boolean { return this.alive }
  drop(): void { this.alive = false }
}

class BlockingConsumer implements Consumer {
  changes: Change[] = []
  since: bigint | number = 0
  readys = 0
  resets = 0
  errors = 0
  closeds = 0
  gate = new ObservablePromise()

  onChange(c: Change): ObservablePromise {
    this.changes.push(c)
    return this.gate
  }
  onReady(): void { this.readys++ }
  onReset(): void {
    this.resets++
    this.changes = []
  }
  onError(_ex: unknown): void { this.errors++ }
  onClosed(): void { this.closeds++ }
  sinceTimestamp(): bigint | number { return this.since }

  release(): void {
    if (this.gate && this.gate.state === 'pending') {
      this.gate.resolve()
    }
  }
}

class ManualSource extends Observable<BinaryEntry> {
  starts = 0
  stops = 0
  pauses = 0
  resumes = 0

  protected override onStart(): void { this.starts++ }
  protected override onStop(): void { this.stops++ }
  protected override onPause(): void { this.pauses++ }
  protected override onResume(): void { this.resumes++ }

  push(k: Uint8Array, v: Uint8Array, ts: number | bigint): void {
    this.onItem({ key: k, value: v, ts: typeof ts === 'bigint' ? ts : BigInt(ts) })
  }
  done(): void { this.onDone() }
  reset(): void { this.onReset() }
  fail(m: string): void { this.onError(new Error(m)) }
  recover(): void { this.onReset() }
}

describe('observable (port of observable_ut.cpp)', () => {
  it('1 idle to loading on subscribe', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    expect(src.state()).to.equal(ObservableState.idle)
    src.subscribe(c)
    expect(src.starts).to.equal(1)
    expect(src.state()).to.equal(ObservableState.loading)
  })

  it('2 loading to ready on done', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    let resolved = false
    src.readyPromise().onResolved(() => { resolved = true })
    expect(src.readyPromise().state).to.equal('pending')
    src.done()
    expect(src.state()).to.equal(ObservableState.ready)
    expect(resolved).to.equal(true)
    expect(c.readys).to.equal(1)
  })

  it('3 ready to reloading on reset oldData readable', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.done()
    src.reset()
    expect(src.state()).to.equal(ObservableState.reloading)
    const entries = src.getEntries()
    expect(entries.length).to.equal(1)
    expectKey(entries[0].key, 'a')
    expect(src.get(b('a'))).to.not.equal(undefined)
  })

  it('4 reloading to ready atomic swap', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.done()
    src.reset()
    src.push(b('b'), b('2'), 2)
    expectKey(src.getEntries()[0].key, 'a')
    src.done()
    expect(src.state()).to.equal(ObservableState.ready)
    const entries = src.getEntries()
    expect(entries.length).to.equal(1)
    expectKey(entries[0].key, 'b')
  })

  it('5 error retains view', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.done()
    src.fail('boom')
    expect(src.state()).to.equal(ObservableState.error)
    expect(src.getEntries().length).to.equal(1)
    expect(c.errors).to.equal(1)
    expect(src.lastError()).to.not.equal(null)
  })

  it('6 error to loading on onItem', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.done()
    src.fail('boom')
    src.push(b('a'), b('1'), 1)
    expect(src.state()).to.equal(ObservableState.loading)
  })

  it('7 last unsubscribe to idle retains view', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    const out = src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.done()
    out.unsubscribe()
    expect(src.state()).to.equal(ObservableState.idle)
    expect(src.stops).to.equal(1)
    expect(src.getEntries().length).to.equal(1)
  })

  it('8 idle to loading on resubscribe', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    const out = src.subscribe(c)
    expect(src.starts).to.equal(1)
    out.unsubscribe()
    const c2 = new RecordingConsumer()
    src.subscribe(c2)
    expect(src.starts).to.equal(2)
    expect(src.state()).to.equal(ObservableState.loading)
  })

  it('9 kill is terminal closed', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.kill()
    expect(src.state()).to.equal(ObservableState.closed)
    expect(c.closeds).to.equal(1)
    const c2 = new RecordingConsumer()
    expect(src.subscribe(c2)).to.equal(null)
  })

  it('10 second subscribe does not onStart', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    const c2 = new RecordingConsumer()
    src.subscribe(c1)
    src.subscribe(c2)
    expect(src.starts).to.equal(1)
  })

  it('11 both consumers get live changes', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    const c2 = new RecordingConsumer()
    src.subscribe(c1)
    src.subscribe(c2)
    src.push(b('k'), b('v'), 1)
    expect(c1.changes.length).to.equal(1)
    expect(c2.changes.length).to.equal(1)
    expectKey(c1.changes[0].key, 'k')
    expectKey(c2.changes[0].key, 'k')
  })

  it('12 unsubscribe one does not stop upstream', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    const c2 = new RecordingConsumer()
    const o1 = src.subscribe(c1)
    src.subscribe(c2)
    o1.unsubscribe()
    expect(src.stops).to.equal(0)
    expect(src.state()).to.equal(ObservableState.loading)
  })

  it('13 unsubscribe both stops upstream', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    const c2 = new RecordingConsumer()
    const o1 = src.subscribe(c1)
    const o2 = src.subscribe(c2)
    o1.unsubscribe()
    o2.unsubscribe()
    expect(src.stops).to.equal(1)
    expect(src.state()).to.equal(ObservableState.idle)
  })

  it('14 new consumer after ready gets full replay', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    src.subscribe(c1)
    src.push(b('a'), b('1'), 1)
    src.push(b('b'), b('2'), 2)
    src.done()
    const c2 = new RecordingConsumer()
    src.subscribe(c2)
    expect(c2.changes.length).to.equal(2)
    expectKey(c2.changes[0].key, 'a')
    expectKey(c2.changes[1].key, 'b')
    expect(c2.readys).to.equal(1)
  })

  it('15 returning consumer sinceTimestamp filters replay', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    src.subscribe(c1)
    src.push(b('a'), b('1'), 1)
    src.push(b('b'), b('2'), 5)
    src.push(b('c'), b('3'), 10)
    src.done()
    const c2 = new RecordingConsumer()
    c2.since = 5
    src.subscribe(c2)
    expect(c2.changes.length).to.equal(1)
    expectKey(c2.changes[0].key, 'c')
  })

  it('16 replay is local no onStart', () => {
    const src = new ManualSource()
    const c1 = new RecordingConsumer()
    src.subscribe(c1)
    src.done()
    expect(src.starts).to.equal(1)
    const c2 = new RecordingConsumer()
    src.subscribe(c2)
    expect(src.starts).to.equal(1)
  })

  it('17 higher ts replaces', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.push(b('a'), b('2'), 2)
    const e = src.get(b('a'))
    expect(e).to.not.equal(undefined)
    expect(bytesEqual(e.value, b('2'))).to.equal(true)
    expect(e.ts).to.equal(2n)
  })

  it('18 lower ts ignored', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('2'), 2)
    src.push(b('a'), b('1'), 1)
    const e = src.get(b('a'))
    expect(e).to.not.equal(undefined)
    expect(bytesEqual(e.value, b('2'))).to.equal(true)
    expect(c.changes.length).to.equal(1)
  })

  it('19 empty value tombstone erases', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.push(b('a'), new Uint8Array(), 2)
    expect(src.get(b('a'))).to.equal(undefined)
    expect(src.getEntries().length).to.equal(0)
    expect(c.changes[c.changes.length - 1].value.length).to.equal(0)
  })

  it('20 maxTs monotonic', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 3)
    src.push(b('b'), b('2'), 1)
    src.push(b('a'), new Uint8Array(), 5)
    expect(src.maxTs()).to.equal(5n)
  })

  it('21 drop consumer detaches and stops', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    expect(src.starts).to.equal(1)
    c.drop()
    src.push(b('x'), b('y'), 1)
    expect(src.stops).to.equal(1)
    expect(src.state()).to.equal(ObservableState.idle)
  })

  it('22 ring_buffer push false when full', () => {
    const rb = new RingBuffer<number>(2)
    expect(rb.push(1)).to.equal(true)
    expect(rb.push(2)).to.equal(true)
    expect(rb.push(3)).to.equal(false)
    expect(rb.size()).to.equal(2)
    expect(rb.pop()).to.equal(1)
    expect(rb.pop()).to.equal(2)
  })

  it('23 ring_buffer wrap around fifo', () => {
    const rb = new RingBuffer<number>(3)
    expect(rb.push(1)).to.equal(true)
    expect(rb.push(2)).to.equal(true)
    expect(rb.push(3)).to.equal(true)
    expect(rb.pop()).to.equal(1)
    expect(rb.pop()).to.equal(2)
    expect(rb.push(4)).to.equal(true)
    expect(rb.push(5)).to.equal(true)
    expect(rb.pop()).to.equal(3)
    expect(rb.pop()).to.equal(4)
    expect(rb.pop()).to.equal(5)
    expect(rb.empty()).to.equal(true)
  })

  it('24 blocking consumer pause on full buffer', () => {
    const src = new ManualSource()
    const c = new BlockingConsumer()
    src.subscribe(c, 1)
    src.push(b('a'), b('1'), 1)
    expect(c.changes.length).to.equal(1)
    expect(src.pauses).to.equal(0)
    src.push(b('b'), b('2'), 2)
    expect(src.pauses).to.equal(1)
    expect(c.changes.length).to.equal(1)
  })

  it('25 resolve gate drains and resumes', () => {
    const src = new ManualSource()
    const c = new BlockingConsumer()
    src.subscribe(c, 1)
    src.push(b('a'), b('1'), 1)
    src.push(b('b'), b('2'), 2)
    expect(src.pauses).to.equal(1)
    c.release()
    expect(c.changes.length).to.equal(2)
    expectKey(c.changes[1].key, 'b')
    expect(src.resumes).to.equal(1)
  })

  it('26 one blocking one sync does not pause source', () => {
    const src = new ManualSource()
    const slow = new BlockingConsumer()
    const fast = new RecordingConsumer()
    src.subscribe(slow, 1)
    src.subscribe(fast, 1)
    src.push(b('a'), b('1'), 1)
    src.push(b('b'), b('2'), 2)
    expect(src.pauses).to.equal(0)
    expect(fast.changes.length).to.equal(2)
    expect(slow.changes.length).to.equal(1)
  })

  it('27 no data loss after drain', () => {
    const src = new ManualSource()
    const c = new BlockingConsumer()
    src.subscribe(c, 8)
    for (let i = 0; i < 9; i++) {
      src.push(b(String(i)), b('v'), i + 1)
    }
    expect(c.changes.length).to.equal(1)
    c.release()
    expect(c.changes.length).to.equal(9)
    expectKey(c.changes[0].key, '0')
    expectKey(c.changes[c.changes.length - 1].key, '8')
  })

  it('28 reset fans out and consumer clears', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.push(b('gone'), b('x'), 2)
    src.done()
    expect(c.changes.length).to.equal(2)
    src.reset()
    expect(c.resets).to.equal(1)
    expect(c.changes.length).to.equal(0)
    src.push(b('a'), b('1'), 1)
    src.done()
    expect(c.changes.length).to.equal(1)
    expectKey(c.changes[0].key, 'a')
    expect(c.readys).to.equal(2)
  })

  it('29 error to reloading via reset', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('a'), b('1'), 1)
    src.done()
    src.fail('boom')
    expect(src.state()).to.equal(ObservableState.error)
    src.recover()
    expect(src.state()).to.equal(ObservableState.reloading)
    expect(c.resets).to.equal(1)
    src.push(b('b'), b('2'), 3)
    src.done()
    expect(src.state()).to.equal(ObservableState.ready)
    expect(src.getEntries().length).to.equal(1)
    expectKey(src.getEntries()[0].key, 'b')
  })

  it('30 readyPromise reresolves after reload', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    const first = src.readyPromise()
    src.done()
    expect(first.state).to.equal('resolved')
    src.reset()
    const second = src.readyPromise()
    expect(second).to.not.equal(first)
    expect(second.state).to.equal('pending')
    let again = false
    second.onResolved(() => { again = true })
    src.push(b('n'), b('v'), 1)
    src.done()
    expect(again).to.equal(true)
    expect(second.state).to.equal('resolved')
  })

  it('31 error to idle retains lastError', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    const out = src.subscribe(c)
    src.done()
    src.fail('boom')
    out.unsubscribe()
    expect(src.state()).to.equal(ObservableState.idle)
    expect(src.lastError()).to.not.equal(null)
    const c2 = new RecordingConsumer()
    src.subscribe(c2)
    expect(src.starts).to.equal(2)
    expect(src.state()).to.equal(ObservableState.loading)
  })

  it('32 recover via retransmit', () => {
    const src = new ManualSource()
    const c = new RecordingConsumer()
    src.subscribe(c)
    src.push(b('old'), b('1'), 1)
    src.done()
    src.fail('boom')
    src.recover()
    src.push(b('new'), b('2'), 2)
    src.done()
    expect(src.state()).to.equal(ObservableState.ready)
    expect(c.changes.length).to.equal(1)
    expectKey(c.changes[0].key, 'new')
    expect(src.getEntries().length).to.equal(1)
    expectKey(src.getEntries()[0].key, 'new')
  })

  it('FinalizationRegistry unsubscribes a collected consumer (last one stops the source)', () => {
    const held: Array<{ target: object, out: { unsubscribe: () => void } }> = []
    setConsumerFinalizerForTest({
      register(target, out) {
        held.push({ target, out })
      },
      unregister() {},
    })
    try {
      const src = new ManualSource()
      const c = new RecordingConsumer()
      src.subscribe(c)
      expect(src.starts).to.equal(1)
      expect(src.stops).to.equal(0)
      expect(held).to.have.length(1)
      held[0].out.unsubscribe()
      expect(src.stops).to.equal(1)
      expect(src.state()).to.equal(ObservableState.idle)
    } finally {
      setConsumerFinalizerForTest(undefined)
    }
  })
})
