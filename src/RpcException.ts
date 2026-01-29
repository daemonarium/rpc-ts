export class RpcException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcException'
  }
}
