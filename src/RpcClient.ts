import type { TypeRegistry, RegisteredMethod } from './typeDescription.js'

export interface RpcClient {
  getMethod(methodId: number): RegisteredMethod
  call(methodId: number, ...args: any[]): Promise<any>
  callMethod<TId>(methodId: number, id: TId, ...args: any[]): Promise<any>
}
