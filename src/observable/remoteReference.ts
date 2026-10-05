import { Observable } from './observable.js'
import { ObservableState, type BinaryEntry } from './types.js'
import type { Disposable, ReferenceOps } from './referenceOps.js'

export type ObservableFactory<EntryT extends BinaryEntry = BinaryEntry> =
  () => Observable<EntryT>

/**
 * Thin handle for one remote dataset. Creating a Reference does no network.
 * observable() / stream() return Observable (live vs scan). hold() is RAII.
 */
export class RemoteReference<EntryT extends BinaryEntry = BinaryEntry> {
  private readonly ops: ReferenceOps
  private readonly liveFactory: ObservableFactory<EntryT>
  private readonly scanFactory: ObservableFactory<EntryT>
  private live: Observable<EntryT> | null = null
  private readonly scans = new Set<Observable<EntryT>>()
  private holdCount = 0
  private setSent = false
  private dropping = false

  constructor(
    ops: ReferenceOps,
    liveFactory: ObservableFactory<EntryT>,
    scanFactory: ObservableFactory<EntryT>
  ) {
    this.ops = ops
    this.liveFactory = liveFactory
    this.scanFactory = scanFactory
  }

  observable(): Observable<EntryT> {
    this.ensureSet()
    if (!this.live) {
      this.live = this.adopt(this.liveFactory())
    }
    return this.live
  }

  stream(): Observable<EntryT> {
    this.ensureSet()
    if (this.live && this.live.activeCount() > 0) {
      return this.live
    }
    const scan = this.adopt(this.scanFactory())
    this.scans.add(scan)
    return scan
  }

  hold(): Disposable {
    this.holdCount++
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.holdCount > 0) this.holdCount--
        this.maybeDrop()
      }
    }
  }

  /** Live observable if observable() was already called. Does not touch the network. */
  peekLive(): Observable<EntryT> | null {
    return this.live
  }

  private ensureSet(): void {
    if (this.setSent) return
    this.setSent = true
    void this.ops.setReference()
  }

  private adopt(obs: Observable<EntryT>): Observable<EntryT> {
    obs.addIdleListener(() => {
      this.scans.delete(obs)
      this.maybeDrop()
    })
    return obs
  }

  private maybeDrop(): void {
    if (this.dropping) return
    if (this.ops.persistent) return
    if (this.holdCount > 0) return
    if (this.live && this.live.activeCount() > 0) return
    for (const scan of this.scans) {
      if (scan.activeCount() > 0) return
    }
    if (!this.setSent) return
    this.dropping = true
    this.setSent = false
    const live = this.live
    this.live = null
    this.scans.clear()
    try {
      void this.ops.dispose()
      if (live && live.state() !== ObservableState.closed) {
        live.kill()
      }
    } finally {
      this.dropping = false
    }
  }
}
