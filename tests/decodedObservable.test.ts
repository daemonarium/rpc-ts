import { expect } from 'chai'

import {
  Observable,
  ObservableState,
  ObservablePromise,
  decodeObservable,
  type BinaryEntry,
  type DecodedConsumer,
  type DecodedEntry,
  type DecodedOutput,
} from '../src/index.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function b(s: string): Uint8Array {
  return enc.encode(s)
}

class ManualSource extends Observable<BinaryEntry> {
  starts = 0
  stops = 0

  protected override onStart(): void { this.starts++ }
  protected override onStop(): void { this.stops++ }

  push(k: string, v: string, ts: number): void {
    this.onItem({ key: b(k), value: b(v), ts: BigInt(ts) })
  }

  tombstone(k: string, ts: number): void {
    this.onItem({ key: b(k), value: new Uint8Array(), ts: BigInt(ts) })
  }

  done(): void { this.onDone() }
  reset(): void { this.onReset() }
  fail(m: string): void { this.onError(new Error(m)) }
}

class RecordingConsumer implements DecodedConsumer<string, string> {
  changes: DecodedEntry<string, string>[] = []
  readys = 0
  resets = 0
  errors = 0
  closeds = 0

  onChange(e: DecodedEntry<string, string>): ObservablePromise {
    this.changes.push(e)
    return ObservablePromise.resolved()
  }
  onReady(): void { this.readys++ }
  onReset(): void { this.resets++ }
  onError(_e: unknown): void { this.errors++ }
  onClosed(): void { this.closeds++ }
}

function make(src = new ManualSource()) {
  const obs = decodeObservable(src, (k) => dec.decode(k), (v) => dec.decode(v))
  return { src, obs }
}

describe('decodedObservable', () => {
  it('constructor does not subscribe the source', () => {
    const { src } = make()
    expect(src.starts).to.equal(0)
    expect(src.state()).to.equal(ObservableState.idle)
  })

  it('first subscribe starts the source, last unsubscribe stops it', () => {
    const { src, obs } = make()
    const a = new RecordingConsumer()
    const outA = obs.subscribe(a)
    expect(src.starts).to.equal(1)
    expect(src.stops).to.equal(0)

    const b = new RecordingConsumer()
    const outB = obs.subscribe(b)
    expect(src.starts).to.equal(1)  // still one source subscription

    obs.unsubscribe(outA)
    expect(src.stops).to.equal(0)
    obs.unsubscribe(outB)
    expect(src.stops).to.equal(1)
  })

  it('resubscribe after idle restarts the source and replays the map', () => {
    const { src, obs } = make()
    const a = new RecordingConsumer()
    const outA = obs.subscribe(a)
    src.push('k', 'v1', 1)
    obs.unsubscribe(outA)
    expect(src.stops).to.equal(1)

    const b = new RecordingConsumer()
    obs.subscribe(b)
    expect(src.starts).to.equal(2)
    expect(b.changes.map((c) => c.value)).to.deep.equal(['v1'])
  })

  it('live entry decodes to a non-null value', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'A', 1)
    const entries = obs.getEntries()
    expect(entries).to.have.length(1)
    expect(entries[0].key).to.equal('a')
    expect(entries[0].value).to.equal('A')
    expect(entries[0].ts).to.equal(1n)
    expect(obs.maxTs()).to.equal(1n)
  })

  it('tombstone is kept as value null', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'A', 1)
    src.tombstone('a', 2)
    const entries = obs.getEntries()
    expect(entries).to.have.length(1)
    expect(entries[0].value).to.equal(null)
    expect(entries[0].ts).to.equal(2n)
  })

  it('live put after a tombstone replaces it', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'A', 1)
    src.tombstone('a', 2)
    src.push('a', 'B', 3)
    const entries = obs.getEntries()
    expect(entries).to.have.length(1)
    expect(entries[0].value).to.equal('B')
    expect(entries[0].ts).to.equal(3n)
  })

  it('older timestamp is dropped (LWW)', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'new', 5)
    src.push('a', 'old', 3)
    src.tombstone('a', 4)
    const entries = obs.getEntries()
    expect(entries).to.have.length(1)
    expect(entries[0].value).to.equal('new')
    expect(entries[0].ts).to.equal(5n)
  })

  it('getEntries is sorted by raw key and includes tombstones', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('b', 'B', 1)
    src.push('a', 'A', 2)
    src.tombstone('c', 3)
    const entries = obs.getEntries()
    expect(entries.map((e) => e.key)).to.deep.equal(['a', 'b', 'c'])
    expect(entries.map((e) => e.value)).to.deep.equal(['A', 'B', null])
  })

  it('get returns live and tombstoned entries', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'A', 1)
    src.tombstone('b', 2)
    expect(obs.get('a')?.value).to.equal('A')
    expect(obs.get('b')?.value).to.equal(null)
    expect(obs.get('missing')).to.equal(undefined)
  })

  it('consumers receive changes and the replay on subscribe', () => {
    const { src, obs } = make()
    obs.subscribe(new RecordingConsumer())
    src.push('a', 'A', 1)
    src.tombstone('b', 2)

    const late = new RecordingConsumer()
    obs.subscribe(late)
    expect(late.changes.map((c) => [c.key, c.value])).to.deep.equal([['a', 'A'], ['b', null]])

    src.push('c', 'C', 3)
    expect(late.changes.map((c) => c.key)).to.deep.equal(['a', 'b', 'c'])
  })

  it('unsubscribe stops delivery to that consumer only', () => {
    const { src, obs } = make()
    const a = new RecordingConsumer()
    const outA: DecodedOutput<string, string> = obs.subscribe(a)
    const b = new RecordingConsumer()
    obs.subscribe(b)
    src.push('a', 'A', 1)
    obs.unsubscribe(outA)
    src.push('b', 'B', 2)
    expect(a.changes.map((c) => c.key)).to.deep.equal(['a'])
    expect(b.changes.map((c) => c.key)).to.deep.equal(['a', 'b'])
  })

  it('reset clears the map and notifies consumers', () => {
    const { src, obs } = make()
    const c = new RecordingConsumer()
    obs.subscribe(c)
    src.push('a', 'A', 1)
    src.done()
    src.reset()
    expect(obs.getEntries()).to.have.length(0)
    expect(obs.maxTs()).to.equal(0n)
    expect(c.resets).to.equal(1)
  })

  it('ready, error and closed are forwarded', () => {
    const { src, obs } = make()
    const c = new RecordingConsumer()
    obs.subscribe(c)
    src.done()
    expect(c.readys).to.equal(1)
    expect(obs.state()).to.equal(ObservableState.ready)
    src.fail('boom')
    expect(c.errors).to.equal(1)
    expect(obs.lastError()).to.be.instanceOf(Error)
  })

  it('dispose unsubscribes all consumers and stops the source once', () => {
    const { src, obs } = make()
    const a = new RecordingConsumer()
    const b = new RecordingConsumer()
    obs.subscribe(a)
    obs.subscribe(b)
    src.push('a', 'A', 1)
    obs.dispose()
    expect(src.stops).to.equal(1)
    // The source is idle: the item stays in its retained view, but the decoded
    // layer only sees it on the next resubscribe replay.
    src.push('b', 'B', 2)
    expect(a.changes.map((c) => c.key)).to.deep.equal(['a'])
    expect(b.changes.map((c) => c.key)).to.deep.equal(['a'])
    expect(obs.getEntries().map((e) => e.key)).to.deep.equal(['a'])

    const late = new RecordingConsumer()
    obs.subscribe(late)
    expect(late.changes.map((c) => c.key)).to.deep.equal(['a', 'b'])
    expect(obs.getEntries().map((e) => e.key)).to.deep.equal(['a', 'b'])
  })

  it('dispose with no consumers does not touch the source', () => {
    const { src, obs } = make()
    obs.dispose()
    expect(src.starts).to.equal(0)
    expect(src.stops).to.equal(0)
  })

  it('unsubscribing an unknown output is a no-op', () => {
    const { src, obs } = make()
    const out = obs.subscribe(new RecordingConsumer())
    obs.unsubscribe(out)
    obs.unsubscribe(out)
    expect(src.stops).to.equal(1)
  })
})
