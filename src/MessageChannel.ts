/**
 * Narrow channel used by observable stream mux / publisher.
 * Narrower than LocalSocket: no kernel, no bind.
 *
 * tryQueueMessage is the C++ try_queue_message: false means the channel is
 * full — do not queue. Caller waits for onWritable.
 */

export interface MessageChannel {
  registerMessageType(typeName: string): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void
  sendMessage(typeName: string, value: object): void
  /** Backpressure: false = channel full, do not queue. Faithful to C++ try_queue_message. */
  tryQueueMessage(typeName: string, value: object): boolean
  isWritable(): boolean
  onWritable(handler: () => void): void
}
