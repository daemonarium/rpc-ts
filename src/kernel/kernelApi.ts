// Auto-generated TypeScript RPC Server
import { TypeRegistry, TypeDescription, TypeKind } from '../typeDescription.js'

// TypeScript type definitions
export interface Kernel_9 {
  "Kernel.create_process": any
  "Kernel.destroy_process": any
  "Kernel.load_module": any
  "Kernel.load_memory": any
  "Kernel.store_memory": any
  "Kernel.initialize_process": any
  "Kernel.finalize_process": any
  "Kernel.send_message": any
  "Kernel.request": any
  "Kernel.link": any
  "Kernel.unlink": any
  "Kernel.connect": any
  "Kernel.disconnect": any
  "Kernel.monitor": any
  "Kernel.unmonitor": any
  "Kernel.set": any
  "Kernel.get": any
  "Kernel.remove": any
  "Kernel.range_get": any
  "Kernel.range_remove": any
  "Kernel.batch_update": any
}

export enum direction_22 {
  Value0 = 0,
  Value1 = 1,
  Value2 = 2,
  Value3 = 3
}

export interface range_30 {
  gt_key: Uint8Array
  gt_inclusive: boolean
  lt_key: Uint8Array
  lt_inclusive: boolean
  limit: number
}

export interface pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32 {
  first: Uint8Array
  second: Uint8Array
}

export interface batch_operation_36 {
  range: range_30
  value: Uint8Array
  type: type_37
}

export enum type_37 {
  Value0 = 0,
  Value1 = 1
}

export interface read_annotation_38 {}

export interface member_annotation_39 {}


export function createGeneratedTypeRegistry(): { registry: TypeRegistry, types: { [key: string]: TypeDescription } } {
  const registry = new TypeRegistry()
  const types: { [key: string]: TypeDescription } = {}

  // Declare types (without members/item/key yet)
  const void_0 = TypeDescription.create({
    name: "void",
    kind: TypeKind.Void,
  })
  types['void_0'] = void_0

  const uint_1 = TypeDescription.create({
    name: "uint",
    kind: TypeKind.UnsignedInteger,
  })
  types['uint_1'] = uint_1

  const sint_2 = TypeDescription.create({
    name: "sint",
    kind: TypeKind.SignedInteger,
  })
  types['sint_2'] = sint_2

  const float_3 = TypeDescription.create({
    name: "float",
    kind: TypeKind.FloatingPoint,
  })
  types['float_3'] = float_3

  const bool_4 = TypeDescription.create({
    name: "bool",
    kind: TypeKind.Boolean,
  })
  types['bool_4'] = bool_4

  const string_5 = TypeDescription.create({
    name: "string",
    kind: TypeKind.String,
  })
  types['string_5'] = string_5

  const binary_6 = TypeDescription.create({
    name: "binary",
    kind: TypeKind.Binary,
  })
  types['binary_6'] = binary_6

  const pointer_7 = TypeDescription.create({
    name: "pointer",
    kind: TypeKind.Pointer,
  })
  types['pointer_7'] = pointer_7

  const map_8 = TypeDescription.create({
    name: "map",
    kind: TypeKind.Map,
  })
  types['map_8'] = map_8

  const Kernel_9 = TypeDescription.create({
    name: "Kernel",
    kind: TypeKind.Object,
  })
  types['Kernel_9'] = Kernel_9

  const Kernel_create_process_10 = TypeDescription.create({
    name: "Kernel.create_process",
    kind: TypeKind.Function,
  })
  types['Kernel_create_process_10'] = Kernel_create_process_10

  const Kernel_destroy_process_11 = TypeDescription.create({
    name: "Kernel.destroy_process",
    kind: TypeKind.Function,
  })
  types['Kernel_destroy_process_11'] = Kernel_destroy_process_11

  const Kernel_load_module_12 = TypeDescription.create({
    name: "Kernel.load_module",
    kind: TypeKind.Function,
  })
  types['Kernel_load_module_12'] = Kernel_load_module_12

  const Kernel_load_memory_13 = TypeDescription.create({
    name: "Kernel.load_memory",
    kind: TypeKind.Function,
  })
  types['Kernel_load_memory_13'] = Kernel_load_memory_13

  const Kernel_store_memory_14 = TypeDescription.create({
    name: "Kernel.store_memory",
    kind: TypeKind.Function,
  })
  types['Kernel_store_memory_14'] = Kernel_store_memory_14

  const Kernel_initialize_process_15 = TypeDescription.create({
    name: "Kernel.initialize_process",
    kind: TypeKind.Function,
  })
  types['Kernel_initialize_process_15'] = Kernel_initialize_process_15

  const Kernel_finalize_process_16 = TypeDescription.create({
    name: "Kernel.finalize_process",
    kind: TypeKind.Function,
  })
  types['Kernel_finalize_process_16'] = Kernel_finalize_process_16

  const Kernel_send_message_17 = TypeDescription.create({
    name: "Kernel.send_message",
    kind: TypeKind.Function,
  })
  types['Kernel_send_message_17'] = Kernel_send_message_17

  const Kernel_request_18 = TypeDescription.create({
    name: "Kernel.request",
    kind: TypeKind.Function,
  })
  types['Kernel_request_18'] = Kernel_request_18

  const Kernel_link_19 = TypeDescription.create({
    name: "Kernel.link",
    kind: TypeKind.Function,
  })
  types['Kernel_link_19'] = Kernel_link_19

  const Kernel_unlink_20 = TypeDescription.create({
    name: "Kernel.unlink",
    kind: TypeKind.Function,
  })
  types['Kernel_unlink_20'] = Kernel_unlink_20

  const Kernel_connect_21 = TypeDescription.create({
    name: "Kernel.connect",
    kind: TypeKind.Function,
  })
  types['Kernel_connect_21'] = Kernel_connect_21

  const direction_22 = TypeDescription.create({
    name: "direction",
    kind: TypeKind.Enum,
    enumMembers: [],
  })
  types['direction_22'] = direction_22

  const Kernel_disconnect_23 = TypeDescription.create({
    name: "Kernel.disconnect",
    kind: TypeKind.Function,
  })
  types['Kernel_disconnect_23'] = Kernel_disconnect_23

  const Kernel_monitor_24 = TypeDescription.create({
    name: "Kernel.monitor",
    kind: TypeKind.Function,
  })
  types['Kernel_monitor_24'] = Kernel_monitor_24

  const Kernel_unmonitor_25 = TypeDescription.create({
    name: "Kernel.unmonitor",
    kind: TypeKind.Function,
  })
  types['Kernel_unmonitor_25'] = Kernel_unmonitor_25

  const Kernel_set_26 = TypeDescription.create({
    name: "Kernel.set",
    kind: TypeKind.Function,
  })
  types['Kernel_set_26'] = Kernel_set_26

  const Kernel_get_27 = TypeDescription.create({
    name: "Kernel.get",
    kind: TypeKind.Function,
  })
  types['Kernel_get_27'] = Kernel_get_27

  const Kernel_remove_28 = TypeDescription.create({
    name: "Kernel.remove",
    kind: TypeKind.Function,
  })
  types['Kernel_remove_28'] = Kernel_remove_28

  const Kernel_range_get_29 = TypeDescription.create({
    name: "Kernel.range_get",
    kind: TypeKind.Function,
  })
  types['Kernel_range_get_29'] = Kernel_range_get_29

  const range_30 = TypeDescription.create({
    name: "range",
    kind: TypeKind.Object,
  })
  types['range_30'] = range_30

  const vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31 = TypeDescription.create({
    name: "vector<pair<vector<unsigned char, allocator<unsigned char>>, vector<unsigned char, allocator<unsigned char>>>, allocator<pair<vector<unsigned char, allocator<unsigned char>>, vector<unsigned char, allocator<unsigned char>>>>>",
    kind: TypeKind.Array,
  })
  types['vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31'] = vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31

  const pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32 = TypeDescription.create({
    name: "pair<vector<unsigned char, allocator<unsigned char>>, vector<unsigned char, allocator<unsigned char>>>",
    kind: TypeKind.Object,
  })
  types['pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32'] = pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32

  const Kernel_range_remove_33 = TypeDescription.create({
    name: "Kernel.range_remove",
    kind: TypeKind.Function,
  })
  types['Kernel_range_remove_33'] = Kernel_range_remove_33

  const Kernel_batch_update_34 = TypeDescription.create({
    name: "Kernel.batch_update",
    kind: TypeKind.Function,
  })
  types['Kernel_batch_update_34'] = Kernel_batch_update_34

  const vector_batch_operation_allocator_batch_operation_35 = TypeDescription.create({
    name: "vector<batch_operation, allocator<batch_operation>>",
    kind: TypeKind.Array,
  })
  types['vector_batch_operation_allocator_batch_operation_35'] = vector_batch_operation_allocator_batch_operation_35

  const batch_operation_36 = TypeDescription.create({
    name: "batch_operation",
    kind: TypeKind.Object,
  })
  types['batch_operation_36'] = batch_operation_36

  const type_37 = TypeDescription.create({
    name: "type",
    kind: TypeKind.Enum,
    enumMembers: [],
  })
  types['type_37'] = type_37

  const read_annotation_38 = TypeDescription.create({
    name: "read_annotation",
    kind: TypeKind.DynamicObject,
    bases: [],
  })
  types['read_annotation_38'] = read_annotation_38

  const member_annotation_39 = TypeDescription.create({
    name: "member_annotation",
    kind: TypeKind.DynamicObject,
  })
  types['member_annotation_39'] = member_annotation_39

  // Register all types to preserve indices
  registry.registerType(void_0)
  registry.registerType(uint_1)
  registry.registerType(sint_2)
  registry.registerType(float_3)
  registry.registerType(bool_4)
  registry.registerType(string_5)
  registry.registerType(binary_6)
  registry.registerType(pointer_7)
  registry.registerType(map_8)
  registry.registerType(Kernel_9)
  registry.registerType(Kernel_create_process_10)
  registry.registerType(Kernel_destroy_process_11)
  registry.registerType(Kernel_load_module_12)
  registry.registerType(Kernel_load_memory_13)
  registry.registerType(Kernel_store_memory_14)
  registry.registerType(Kernel_initialize_process_15)
  registry.registerType(Kernel_finalize_process_16)
  registry.registerType(Kernel_send_message_17)
  registry.registerType(Kernel_request_18)
  registry.registerType(Kernel_link_19)
  registry.registerType(Kernel_unlink_20)
  registry.registerType(Kernel_connect_21)
  registry.registerType(direction_22)
  registry.registerType(Kernel_disconnect_23)
  registry.registerType(Kernel_monitor_24)
  registry.registerType(Kernel_unmonitor_25)
  registry.registerType(Kernel_set_26)
  registry.registerType(Kernel_get_27)
  registry.registerType(Kernel_remove_28)
  registry.registerType(Kernel_range_get_29)
  registry.registerType(range_30)
  registry.registerType(vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31)
  registry.registerType(pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32)
  registry.registerType(Kernel_range_remove_33)
  registry.registerType(Kernel_batch_update_34)
  registry.registerType(vector_batch_operation_allocator_batch_operation_35)
  registry.registerType(batch_operation_36)
  registry.registerType(type_37)
  registry.registerType(read_annotation_38)
  registry.registerType(member_annotation_39)

  // Fill enumMembers, bases, item/key
  Kernel_create_process_10.item = uint_1

  Kernel_destroy_process_11.item = void_0

  Kernel_load_module_12.item = void_0

  Kernel_load_memory_13.item = void_0

  Kernel_store_memory_14.item = void_0

  Kernel_initialize_process_15.item = void_0

  Kernel_finalize_process_16.item = void_0

  Kernel_send_message_17.item = void_0

  Kernel_request_18.item = binary_6

  Kernel_link_19.item = void_0

  Kernel_unlink_20.item = void_0

  Kernel_connect_21.item = void_0

  direction_22.enumMembers = [
    { name: undefined, value: undefined },
    { name: undefined, value: undefined },
    { name: undefined, value: undefined },
    { name: undefined, value: undefined },
  ]

  Kernel_disconnect_23.item = void_0

  Kernel_monitor_24.item = void_0

  Kernel_unmonitor_25.item = void_0

  Kernel_set_26.item = void_0

  Kernel_get_27.item = binary_6

  Kernel_remove_28.item = void_0

  Kernel_range_get_29.item = vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31

  vector_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_allocator_pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_31.item = pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32

  Kernel_range_remove_33.item = void_0

  Kernel_batch_update_34.item = void_0

  vector_batch_operation_allocator_batch_operation_35.item = batch_operation_36

  type_37.enumMembers = [
    { name: undefined, value: undefined },
    { name: undefined, value: undefined },
  ]

  read_annotation_38.bases = [
    member_annotation_39,
  ]

  // Fill members (after all types exist)
  Kernel_9.members = [
    {
      name: "Kernel.create_process",
      type: Kernel_create_process_10,
      annotations: [],
    },
    {
      name: "Kernel.destroy_process",
      type: Kernel_destroy_process_11,
      annotations: [],
    },
    {
      name: "Kernel.load_module",
      type: Kernel_load_module_12,
      annotations: [],
    },
    {
      name: "Kernel.load_memory",
      type: Kernel_load_memory_13,
      annotations: [],
    },
    {
      name: "Kernel.store_memory",
      type: Kernel_store_memory_14,
      annotations: [],
    },
    {
      name: "Kernel.initialize_process",
      type: Kernel_initialize_process_15,
      annotations: [],
    },
    {
      name: "Kernel.finalize_process",
      type: Kernel_finalize_process_16,
      annotations: [],
    },
    {
      name: "Kernel.send_message",
      type: Kernel_send_message_17,
      annotations: [],
    },
    {
      name: "Kernel.request",
      type: Kernel_request_18,
      annotations: [],
    },
    {
      name: "Kernel.link",
      type: Kernel_link_19,
      annotations: [],
    },
    {
      name: "Kernel.unlink",
      type: Kernel_unlink_20,
      annotations: [],
    },
    {
      name: "Kernel.connect",
      type: Kernel_connect_21,
      annotations: [],
    },
    {
      name: "Kernel.disconnect",
      type: Kernel_disconnect_23,
      annotations: [],
    },
    {
      name: "Kernel.monitor",
      type: Kernel_monitor_24,
      annotations: [],
    },
    {
      name: "Kernel.unmonitor",
      type: Kernel_unmonitor_25,
      annotations: [],
    },
    {
      name: "Kernel.set",
      type: Kernel_set_26,
      annotations: [],
    },
    {
      name: "Kernel.get",
      type: Kernel_get_27,
      annotations: [],
    },
    {
      name: "Kernel.remove",
      type: Kernel_remove_28,
      annotations: [],
    },
    {
      name: "Kernel.range_get",
      type: Kernel_range_get_29,
      annotations: [],
    },
    {
      name: "Kernel.range_remove",
      type: Kernel_range_remove_33,
      annotations: [],
    },
    {
      name: "Kernel.batch_update",
      type: Kernel_batch_update_34,
      annotations: [],
    },
  ]

  Kernel_destroy_process_11.members = [
    {
      name: "id",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_load_module_12.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "module_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
    {
      name: "flags",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_load_memory_13.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_store_memory_14.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_initialize_process_15.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_finalize_process_16.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_send_message_17.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "message",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_request_18.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "message",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_link_19.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "from_module",
      type: uint_1,
      annotations: [],
    },
    {
      name: "to_module",
      type: uint_1,
      annotations: [],
    },
    {
      name: "from_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "to_name",
      type: string_5,
      annotations: [],
    },
  ]

  Kernel_unlink_20.members = [
    {
      name: "process_id",
      type: uint_1,
      annotations: [],
    },
    {
      name: "from_module",
      type: uint_1,
      annotations: [],
    },
    {
      name: "to_module",
      type: uint_1,
      annotations: [],
    },
    {
      name: "from_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "to_name",
      type: string_5,
      annotations: [],
    },
  ]

  Kernel_connect_21.members = [
    {
      name: "process_from",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_from",
      type: uint_1,
      annotations: [],
    },
    {
      name: "process_to",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_to",
      type: uint_1,
      annotations: [],
    },
    {
      name: "direction",
      type: direction_22,
      annotations: [],
    },
  ]

  Kernel_disconnect_23.members = [
    {
      name: "process_from",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_from",
      type: uint_1,
      annotations: [],
    },
    {
      name: "process_to",
      type: uint_1,
      annotations: [],
    },
    {
      name: "channel_to",
      type: uint_1,
      annotations: [],
    },
    {
      name: "direction",
      type: direction_22,
      annotations: [],
    },
  ]

  Kernel_monitor_24.members = [
    {
      name: "target",
      type: uint_1,
      annotations: [],
    },
    {
      name: "monitor",
      type: uint_1,
      annotations: [],
    },
    {
      name: "monitor_channel",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_unmonitor_25.members = [
    {
      name: "target",
      type: uint_1,
      annotations: [],
    },
    {
      name: "monitor",
      type: uint_1,
      annotations: [],
    },
    {
      name: "monitor_channel",
      type: uint_1,
      annotations: [],
    },
  ]

  Kernel_set_26.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
    {
      name: "value",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_get_27.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_remove_28.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "key",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_range_get_29.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "range",
      type: range_30,
      annotations: [],
    },
  ]

  range_30.members = [
    {
      name: "gt_key",
      type: binary_6,
      annotations: [],
    },
    {
      name: "gt_inclusive",
      type: bool_4,
      annotations: [],
    },
    {
      name: "lt_key",
      type: binary_6,
      annotations: [],
    },
    {
      name: "lt_inclusive",
      type: bool_4,
      annotations: [],
    },
    {
      name: "limit",
      type: uint_1,
      annotations: [],
    },
  ]

  pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32.members = [
    {
      name: "first",
      type: binary_6,
      annotations: [],
    },
    {
      name: "second",
      type: binary_6,
      annotations: [],
    },
  ]

  Kernel_range_remove_33.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "range",
      type: range_30,
      annotations: [],
    },
  ]

  Kernel_batch_update_34.members = [
    {
      name: "db_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "table_name",
      type: string_5,
      annotations: [],
    },
    {
      name: "operations",
      type: vector_batch_operation_allocator_batch_operation_35,
      annotations: [],
    },
  ]

  batch_operation_36.members = [
    {
      name: "range",
      type: range_30,
      annotations: [],
    },
    {
      name: "value",
      type: binary_6,
      annotations: [],
    },
    {
      name: "type",
      type: type_37,
      annotations: [],
    },
  ]

  return { registry, types }
}

// Empty method implementations
async function Kernel_create_process_10_impl(
): Promise<number> {
  /// TODO: implement
  return Promise.resolve(0)
}

async function Kernel_destroy_process_11_impl(
  id: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_load_module_12_impl(
  process_id: number,
  module_id: number,
  db_name: string,
  table_name: string,
  key: Uint8Array,
  flags: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_load_memory_13_impl(
  process_id: number,
  db_name: string,
  table_name: string,
  key: Uint8Array
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_store_memory_14_impl(
  process_id: number,
  db_name: string,
  table_name: string,
  key: Uint8Array
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_initialize_process_15_impl(
  process_id: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_finalize_process_16_impl(
  process_id: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_send_message_17_impl(
  process_id: number,
  channel_id: number,
  message: Uint8Array
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_request_18_impl(
  process_id: number,
  channel_id: number,
  message: Uint8Array
): Promise<Uint8Array> {
  /// TODO: implement
  return Promise.resolve(null as any as Uint8Array)
}

async function Kernel_link_19_impl(
  process_id: number,
  from_module: number,
  to_module: number,
  from_name: string,
  to_name: string
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_unlink_20_impl(
  process_id: number,
  from_module: number,
  to_module: number,
  from_name: string,
  to_name: string
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_connect_21_impl(
  process_from: number,
  channel_from: number,
  process_to: number,
  channel_to: number,
  direction: direction_22
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_disconnect_23_impl(
  process_from: number,
  channel_from: number,
  process_to: number,
  channel_to: number,
  direction: direction_22
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_monitor_24_impl(
  target: number,
  monitor: number,
  monitor_channel: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_unmonitor_25_impl(
  target: number,
  monitor: number,
  monitor_channel: number
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_set_26_impl(
  db_name: string,
  table_name: string,
  key: Uint8Array,
  value: Uint8Array
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_get_27_impl(
  db_name: string,
  table_name: string,
  key: Uint8Array
): Promise<Uint8Array> {
  /// TODO: implement
  return Promise.resolve(null as any as Uint8Array)
}

async function Kernel_remove_28_impl(
  db_name: string,
  table_name: string,
  key: Uint8Array
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_range_get_29_impl(
  db_name: string,
  table_name: string,
  range: range_30
): Promise<pair_vector_unsigned_char_allocator_unsigned_char_vector_unsigned_char_allocator_unsigned_char_32[]> {
  /// TODO: implement
  return Promise.resolve([])
}

async function Kernel_range_remove_33_impl(
  db_name: string,
  table_name: string,
  range: range_30
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

async function Kernel_batch_update_34_impl(
  db_name: string,
  table_name: string,
  operations: batch_operation_36[]
): Promise<void> {
  /// TODO: implement
  return Promise.resolve()
}

export function implementMethods(result: ReturnType<typeof createGeneratedTypeRegistry>): void {
  const { registry, types } = result
  types['Kernel_create_process_10'].implementation = Kernel_create_process_10_impl
  types['Kernel_destroy_process_11'].implementation = Kernel_destroy_process_11_impl
  types['Kernel_load_module_12'].implementation = Kernel_load_module_12_impl
  types['Kernel_load_memory_13'].implementation = Kernel_load_memory_13_impl
  types['Kernel_store_memory_14'].implementation = Kernel_store_memory_14_impl
  types['Kernel_initialize_process_15'].implementation = Kernel_initialize_process_15_impl
  types['Kernel_finalize_process_16'].implementation = Kernel_finalize_process_16_impl
  types['Kernel_send_message_17'].implementation = Kernel_send_message_17_impl
  types['Kernel_request_18'].implementation = Kernel_request_18_impl
  types['Kernel_link_19'].implementation = Kernel_link_19_impl
  types['Kernel_unlink_20'].implementation = Kernel_unlink_20_impl
  types['Kernel_connect_21'].implementation = Kernel_connect_21_impl
  types['Kernel_disconnect_23'].implementation = Kernel_disconnect_23_impl
  types['Kernel_monitor_24'].implementation = Kernel_monitor_24_impl
  types['Kernel_unmonitor_25'].implementation = Kernel_unmonitor_25_impl
  types['Kernel_set_26'].implementation = Kernel_set_26_impl
  types['Kernel_get_27'].implementation = Kernel_get_27_impl
  types['Kernel_remove_28'].implementation = Kernel_remove_28_impl
  types['Kernel_range_get_29'].implementation = Kernel_range_get_29_impl
  types['Kernel_range_remove_33'].implementation = Kernel_range_remove_33_impl
  types['Kernel_batch_update_34'].implementation = Kernel_batch_update_34_impl
}

export function setupServer(): TypeRegistry {
  const result = createGeneratedTypeRegistry()
  implementMethods(result)
  result.registry.assignMethodIds()
  return result.registry
}
