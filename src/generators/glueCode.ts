import type { TypeRegistry } from '../typeDescription.js'
import type { GeneratorOptions } from './cppClient.js'

export interface GlueCodeGenerator {
  name: string
  generate: (registry: TypeRegistry, options?: GeneratorOptions) => Promise<string> | string
}

export const glueCodeGenerators: GlueCodeGenerator[] = [
  {
    name: 'C++ Types',
    generate: async (registry, options) => {
      const { generateCppTypesCode } = await import('./cppTypes.js')
      return generateCppTypesCode(registry, options)
    }
  },
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
  },
  {
    name: 'TS Type Registry',
    generate: async (registry) => {
      const { generateTsTypeRegistry } = await import('./tsTypeRegistry.js')
      return generateTsTypeRegistry(registry)
    }
  },
  {
    name: 'TS Server',
    generate: async (registry) => {
      const { generateTsServer } = await import('./tsServer.js')
      return generateTsServer(registry)
    }
  },
  {
    name: 'TS Client',
    generate: async (registry, options) => {
      const { generateTsClient } = await import('./tsClient.js')
      return generateTsClient(registry, options)
    }
  }
]
