import type { TypeRegistry } from '../typeDescription.js'
import type { GeneratorOptions } from './cpp.js'

export interface GlueCodeGenerator {
  name: string
  generate: (registry: TypeRegistry, options?: GeneratorOptions) => Promise<string> | string
}

export const glueCodeGenerators: GlueCodeGenerator[] = [
  {
    name: 'C++',
    generate: async (registry, options) => {
      const { generateCppGlueCode } = await import('./cpp.js')
      return generateCppGlueCode(registry, options)
    }
  }
]
