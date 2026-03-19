export class RpcException extends Error {
  readonly typeName?: string

  constructor(message: string, typeName?: string) {
    super(message)
    this.name = 'RpcException'
    this.typeName = typeName
  }
}
