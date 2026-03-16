#!/usr/bin/env node

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { readFileSync } from 'fs'
import { TypeRegistry, deserializeTypeRegistry, glueCodeGenerators } from './index.js'
import type { GeneratorOptions } from './generators/cppClient.js'

function wasiImports(memory: WebAssembly.Memory) {
  const decoder = new TextDecoder()
  let stdout = ''
  let stderr = ''

  function readIovs(iovsPtr: number, iovsLen: number): string {
    const mem = new DataView(memory.buffer)
    const bytes = new Uint8Array(memory.buffer)
    let totalStr = ''
    let totalWritten = 0
    for (let i = 0; i < iovsLen; i++) {
      const base = iovsPtr + i * 8
      const buf = mem.getUint32(base, true)
      const bufLen = mem.getUint32(base + 4, true)
      totalStr += decoder.decode(bytes.slice(buf, buf + bufLen))
      totalWritten += bufLen
    }
    return totalStr
  }

  return {
    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const str = readIovs(iovsPtr, iovsLen)
      const mem = new DataView(memory.buffer)
      const byteLength = new TextEncoder().encode(str).length
      mem.setUint32(nwrittenPtr, byteLength, true)
      if (fd === 1) {
        stdout += str
        if (str.includes('\n')) {
          const lines = stdout.split('\n')
          for (let i = 0; i < lines.length - 1; i++) {
            console.log(`[module] ${lines[i]}`)
          }
          stdout = lines[lines.length - 1]
        }
      } else if (fd === 2) {
        stderr += str
        if (str.includes('\n')) {
          const lines = stderr.split('\n')
          for (let i = 0; i < lines.length - 1; i++) {
            console.error(`[module] ${lines[i]}`)
          }
          stderr = lines[lines.length - 1]
        }
      }
      return 0
    },
    fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const mem = new DataView(memory.buffer)
      mem.setUint32(nreadPtr, 0, true)
      return 0
    },
    fd_seek(fd: number, offsetLow: number, offsetHigh: number, whence: number, newoffsetPtr: number): number {
      const mem = new DataView(memory.buffer)
      mem.setUint32(newoffsetPtr, 0, true)
      mem.setUint32(newoffsetPtr + 4, 0, true)
      return 0
    },
    fd_close(fd: number): number {
      return 0
    },
    environ_sizes_get(countPtr: number, bufSizePtr: number): number {
      const mem = new DataView(memory.buffer)
      mem.setUint32(countPtr, 0, true)
      mem.setUint32(bufSizePtr, 0, true)
      return 0
    },
    environ_get(environPtr: number, environBufPtr: number): number {
      return 0
    },
  }
}

function waosImports() {
  return {
    waos_socket_flush(socket: number) {
      throw new Error('waos_socket_flush not implemented')
    },  
    waos_socket_input_drain(socket: number) {
      throw new Error('waos_socket_input_drain not implemented')
    },
    waos_use_mana(mana: number) {
      // ignore
    }
  }
}

async function loadWasmModule(filePath: string, socket: number = 0): Promise<TypeRegistry> {
  const wasmBuffer = readFileSync(filePath)
  const wasmModule = await WebAssembly.compile(wasmBuffer)
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048 })
  
  const imports = {
    env: {
      memory: memory,
    },
    waos: waosImports()
  }

  const moduleImports = WebAssembly.Module.imports(wasmModule)
  const needsWasi = moduleImports.some(i => i.module === 'wasi_snapshot_preview1')
  if (needsWasi) {
    imports['wasi_snapshot_preview1'] = wasiImports(memory) as unknown as Record<string, any>
  }
  const needsEmscripten = moduleImports.some(i => i.name === 'emscripten_notify_memory_growth')
  if (needsEmscripten) {
    ;(imports['env'] as Record<string, any>)['emscripten_notify_memory_growth'] = () => {}
  }
  
  const instance = await WebAssembly.instantiate(wasmModule, imports)
  //@ts-ignore
  instance.exports._initialize()
  
  // Read RPC description from WASM
  const pointer = (instance.exports.malloc as (size: number) => number)(4)
  if (!pointer) {
    throw new Error('Failed to allocate memory for rpc description')
  }  

  /// call exported rpc_description to get the description
  const rpcDescription = instance.exports.rpc_description as ((socket: number, pointer: number) => number) | undefined
  if (!rpcDescription) {
    throw new Error('rpc_description not exported from WASM module')
  }
  const descriptionSize = rpcDescription(socket, pointer)
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
    .command(
      '$0 <inputFile>',
      'Generate code from WASM or WDEF file',
      y => y.positional('inputFile', {
        describe: 'Input .wasm or .wdef file',
        type: 'string',
      })
    )    
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
    .option('socket', {
      alias: 's',
      type: 'number',
      description: 'Module socket index',
      default: 0,
      demandOption: true,
    })
    .help()
    .alias('help', 'h')
    .version(false)
    .parse()

  const inputFile = argv.inputFile as string
  if (!inputFile) {
    console.error('Error: Input file (.wasm or .wdef) is required')
    process.exit(1)
  }

  let registry: TypeRegistry

  try {
    if (inputFile.endsWith('.wasm')) {
      registry = await loadWasmModule(inputFile, argv.socket)
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
