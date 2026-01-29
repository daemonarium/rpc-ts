#!/usr/bin/env node

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { readFileSync } from 'fs'
import { TypeRegistry, deserializeTypeRegistry, glueCodeGenerators } from './index.js'
import type { GeneratorOptions } from './generators/cppClient.js'

async function loadWasmModule(filePath: string): Promise<TypeRegistry> {
  const wasmBuffer = readFileSync(filePath)
  const wasmModule = await WebAssembly.compile(wasmBuffer)
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048 })
  
  const imports = {
    env: {
      memory: memory,
      send_message: (_socket: number, _buffer: ArrayBuffer, _size: number) => {
        // No-op for CLI
      },
    },
  }
  
  const instance = await WebAssembly.instantiate(wasmModule, imports)
  //@ts-ignore
  instance.exports._initialize()
  
  // Read RPC description from WASM
  const pointer = (instance.exports.malloc as (size: number) => number)(4)
  if (!pointer) {
    throw new Error('Failed to allocate memory for rpc description')
  }
  
  const descriptionSize = (instance.exports.rpc_description as (pointer: number) => number)(pointer)
  if (!descriptionSize) {
    throw new Error('Failed to get rpc description')
  }
  
  const descriptionPointer = new Uint32Array(memory.buffer, pointer, 1)[0]
  if (!descriptionPointer) {
    throw new Error('Failed to read description pointer')
  }
  
  const serialized = new Uint8Array(memory.buffer, descriptionPointer, descriptionSize)
  return deserializeTypeRegistry(serialized)
}

function loadWdefFile(filePath: string): TypeRegistry {
  const buffer = readFileSync(filePath)
  return deserializeTypeRegistry(new Uint8Array(buffer))
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('language', {
      alias: 'l',
      type: 'string',
      description: 'Target language for code generation',
      demandOption: true,
    })
    .option('className', {
      alias: 'c',
      type: 'string',
      description: 'Class name for generated code',
    })
    .option('namespace', {
      alias: 'n',
      type: 'string',
      description: 'Namespace for generated code (C++)',
    })
    .help()
    .alias('help', 'h')
    .version(false)
    .parse()

  const inputFile = argv._[0] as string
  if (!inputFile) {
    console.error('Error: Input file (.wasm or .wdef) is required')
    process.exit(1)
  }

  let registry: TypeRegistry

  try {
    if (inputFile.endsWith('.wasm')) {
      registry = await loadWasmModule(inputFile)
    } else if (inputFile.endsWith('.wdef')) {
      registry = loadWdefFile(inputFile)
    } else {
      console.error('Error: Input file must have .wasm or .wdef extension')
      process.exit(1)
    }
  } catch (error) {
    console.error('Error loading file:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // Find generator
  const generator = glueCodeGenerators.find(gen => 
    gen.name.toLowerCase() === argv.language.toLowerCase() ||
    gen.name === argv.language
  )

  if (!generator) {
    console.error(`Error: Generator for language "${argv.language}" not found`)
    console.error(`Available languages: ${glueCodeGenerators.map(g => g.name).join(', ')}`)
    process.exit(1)
  }

  // Generate code
  try {
    const options: GeneratorOptions = {}
    if (argv.className) {
      options.className = argv.className
    }
    if (argv.namespace) {
      options.namespace = argv.namespace
    }

    const code = await generator.generate(registry, options)
    console.log(code)
  } catch (error) {
    console.error('Error generating code:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

main().catch(error => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
