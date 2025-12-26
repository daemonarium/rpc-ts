import type { TypeRegistry } from '../typeDescription.js'
import type { GeneratorOptions } from './cppClient.js'

export interface GlueCodeGenerator {
  name: string
  generate: (registry: TypeRegistry, options?: GeneratorOptions) => Promise<string> | string
}

export const glueCodeGenerators: GlueCodeGenerator[] = [
  {
    name: 'C++ Client',
    generate: async (registry, options) => {
      const { generateCppGlueCode } = await import('./cppClient.js')
      return generateCppGlueCode(registry, options)
    }
  },
  {
    name: 'C++ Server',
    generate: async (registry, options) => {
      const { generateCppServerCode } = await import('./cppServer.js')
      return generateCppServerCode(registry, options)
    }
  }
]
