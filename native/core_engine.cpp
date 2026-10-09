// C++20 LWW projection. Only authenticated, authorized, decrypted commands cross this ABI.
// No networking, storage, cryptography or JSON is implemented here.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <new>
#include <numeric>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <emscripten/heap.h>

namespace {
constexpr uint32_t INPUT_MAGIC = 0x31574353; // SCW1
constexpr uint32_t OUTPUT_MAGIC = 0x314f4353; // SCO1
constexpr uint32_t ABI_VERSION = 1;
constexpr uint32_t MAX_BYTES = 128 * 1024 * 1024;
constexpr uint32_t MAX_EVENTS = 1000000;
constexpr uint64_t MAX_SAFE = 9007199254740991ULL;

struct InvalidInput {};
struct Slice { const uint8_t* data = nullptr; uint32_t units = 0; };
uint16_t code_unit(const Slice& s, uint32_t index) {
  return uint16_t(s.data[index * 2]) | (uint16_t(s.data[index * 2 + 1]) << 8);
}
int compare(const Slice& a, const Slice& b) {
  for (uint32_t i = 0, end = std::min(a.units, b.units); i < end; ++i) {
    const auto x = code_unit(a, i), y = code_unit(b, i);
    if (x != y) return x < y ? -1 : 1;
  }
  return a.units < b.units ? -1 : a.units > b.units ? 1 : 0;
}
struct SliceHash {
  size_t operator()(const Slice& s) const {
    uint32_t hash = 2166136261u;
    for (uint32_t i = 0; i < s.units * 2; ++i) hash = (hash ^ s.data[i]) * 16777619u;
    return hash;
  }
};
struct SliceEqual {
  bool operator()(const Slice& a, const Slice& b) const {
    return a.units == b.units && (!a.units || std::memcmp(a.data, b.data, size_t(a.units) * 2) == 0);
  }
};
bool matches(const Slice& s, const char* ascii) {
  const auto length = std::strlen(ascii);
  if (s.units != length) return false;
  for (uint32_t i = 0; i < s.units; ++i) if (code_unit(s, i) != uint8_t(ascii[i])) return false;
  return true;
}
bool ascii_identifier(const Slice& s) {
  if (!s.units || s.units > 128) return false;
  for (uint32_t i = 0; i < s.units; ++i) {
    const auto c = code_unit(s, i);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return true;
}
struct Reader {
  const uint8_t* data;
  uint32_t size;
  uint32_t offset = 0;
  const uint8_t* take(uint32_t length) {
    if (length > size - offset) throw InvalidInput{};
    const auto p = data + offset; offset += length; return p;
  }
  uint32_t u32() {
    const auto p = take(4);
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
  }
  uint64_t u64() { const uint64_t low = u32(), high = u32(); return low | (high << 32); }
  double f64() {
    const uint64_t bits = u64(); double value; std::memcpy(&value, &bits, 8);
    if (!std::isfinite(value)) throw InvalidInput{};
    return value;
  }
  Slice string() {
    const auto units = u32();
    if (units > (size - offset) / 2) throw InvalidInput{};
    return {take(units * 2), units};
  }
};
std::vector<uint8_t> output;
void append32(uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) output.push_back(uint8_t(value >> shift));
}
void append_string(const Slice& s) {
  if (output.size() + 4 + size_t(s.units) * 2 > MAX_BYTES) throw InvalidInput{};
  append32(s.units); output.insert(output.end(), s.data, s.data + size_t(s.units) * 2);
}
struct Stamp { uint64_t lamport = 0, sequence = 0; uint32_t actor_rank = 0; };
bool later(const Stamp& a, const Stamp& b) {
  if (a.lamport != b.lamport) return a.lamport > b.lamport;
  if (a.actor_rank != b.actor_rank) return a.actor_rank > b.actor_rank;
  return a.sequence > b.sequence;
}
struct Value { uint32_t tag = 0; double number = 0; Slice text; };
struct Register { Stamp stamp; Value value; };
struct Item {
  Stamp existence;
  bool present = false;
  std::unordered_map<uint32_t, Register> fields;
};
struct SliceDictionary {
  std::array<Slice, 16> small{};
  std::vector<Slice> large;
  uint32_t count = 0;
  Slice* data() { return count <= small.size() ? small.data() : large.data(); }
  const Slice* data() const { return count <= small.size() ? small.data() : large.data(); }
  const Slice& operator[](uint32_t i) const { return data()[i]; }
  const Slice* begin() const { return data(); }
  const Slice* end() const { return data() + count; }
};
SliceDictionary dictionary(Reader& r, uint32_t count, unsigned kind) {
  if (count > MAX_EVENTS || count > (r.size - r.offset) / 4) throw InvalidInput{};
  SliceDictionary entries; entries.count = count;
  if (count > entries.small.size()) entries.large.resize(count);
  std::unordered_set<Slice, SliceHash, SliceEqual> seen;
  if (count > entries.small.size()) seen.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    const auto s = r.string();
    if ((kind < 2 && !ascii_identifier(s)) ||
        (kind == 2 && (!s.units || s.units > 128 || matches(s, "__proto__") || matches(s, "constructor") || matches(s, "prototype"))) ||
        (count > entries.small.size() && !seen.insert(s).second)) throw InvalidInput{};
    if (count <= entries.small.size()) for (uint32_t previous = 0; previous < i; ++previous) if (SliceEqual{}(entries[previous], s)) throw InvalidInput{};
    entries.data()[i] = s;
  }
  return entries;
}
void write_value(const Value& value) {
  append32(value.tag);
  if (value.tag == 3) {
    uint64_t bits; std::memcpy(&bits, &value.number, 8);
    append32(uint32_t(bits)); append32(uint32_t(bits >> 32));
  } else if (value.tag == 4) append_string(value.text);
}
void clear_output() {
  // Avoid keeping plaintext in the reusable output allocation between operations.
  std::fill(output.begin(), output.end(), 0); output.clear();
}
void merge(const uint8_t* buffer, uint32_t size) {
  Reader r{buffer, size};
  if (r.u32() != INPUT_MAGIC || r.u32() != ABI_VERSION) throw InvalidInput{};
  const auto count = r.u32(), declared_size = r.u32();
  const auto actor_count = r.u32(), item_count = r.u32(), key_count = r.u32();
  const auto dictionary_offset = r.u32();
  if (dictionary_offset < 32 || dictionary_offset > size || size != declared_size || count > MAX_EVENTS || (count && (!actor_count || !item_count))) throw InvalidInput{};
  Reader dictionaries{buffer + dictionary_offset, size - dictionary_offset};
  const auto actors = dictionary(dictionaries, actor_count, 0);
  const auto names = dictionary(dictionaries, item_count, 1);
  const auto keys = dictionary(dictionaries, key_count, 2);
  if (dictionaries.offset != dictionaries.size) throw InvalidInput{};
  r.size = dictionary_offset;
  if (count > (r.size - r.offset) / 32) throw InvalidInput{};
  // Dictionary indices are arrival-dependent, so compare ranks by ordinal ActorID.
  std::vector<uint32_t> actor_order(actor_count), rank(actor_count);
  std::iota(actor_order.begin(), actor_order.end(), 0);
  std::sort(actor_order.begin(), actor_order.end(), [&](auto a, auto b) { return compare(actors[a], actors[b]) < 0; });
  for (uint32_t i = 0; i < actor_count; ++i) rank[actor_order[i]] = i;
  std::vector<Item> items(item_count);
  std::unordered_set<uint32_t> field_keys;
  std::array<uint32_t, 16> small_field_keys{};
  for (uint32_t i = 0; i < count; ++i) {
    const auto lamport = r.u64(), sequence = r.u64();
    const auto actor = r.u32(), item_index = r.u32(), type = r.u32(), fields = r.u32();
    if (!lamport || lamport > MAX_SAFE || !sequence || sequence > MAX_SAFE || actor >= actor_count ||
        item_index >= item_count || type < 1 || type > 3 || fields > key_count || (type == 3 && fields)) throw InvalidInput{};
    const Stamp stamp{lamport, sequence, rank[actor]};
    auto& item = items[item_index];
    if (type != 2 && later(stamp, item.existence)) { item.existence = stamp; item.present = type == 1; }
    if (fields > small_field_keys.size()) field_keys.clear();
    for (uint32_t f = 0; f < fields; ++f) {
      const auto key_index = r.u32(), tag = r.u32();
      if (key_index >= key_count || tag > 4) throw InvalidInput{};
      if (fields <= small_field_keys.size()) {
        for (uint32_t previous = 0; previous < f; ++previous) if (small_field_keys[previous] == key_index) throw InvalidInput{};
        small_field_keys[f] = key_index;
      } else if (!field_keys.insert(key_index).second) throw InvalidInput{};
      Value value; value.tag = tag;
      if (tag == 3) value.number = r.f64();
      else if (tag == 4) value.text = r.string();
      auto [entry, inserted] = item.fields.try_emplace(key_index);
      if (inserted || later(stamp, entry->second.stamp)) entry->second = {stamp, value};
    }
  }
  if (r.offset != dictionary_offset) throw InvalidInput{};
  std::vector<uint32_t> visible;
  for (uint32_t i = 0; i < item_count; ++i) if (items[i].present) visible.push_back(i);
  std::sort(visible.begin(), visible.end(), [&](auto a, auto b) { return compare(names[a], names[b]) < 0; });
  append32(OUTPUT_MAGIC); append32(ABI_VERSION); append32(uint32_t(visible.size())); append32(0);
  std::vector<uint32_t> field_order;
  for (const auto index : visible) {
    const auto& item = items[index]; append32(index); append32(uint32_t(item.fields.size()));
    field_order.clear(); field_order.reserve(item.fields.size());
    for (const auto& [key, unused] : item.fields) field_order.push_back(key);
    std::sort(field_order.begin(), field_order.end(), [&](auto a, auto b) { return compare(keys[a], keys[b]) < 0; });
    for (const auto key : field_order) { append32(key); write_value(item.fields.at(key).value); }
  }
  if (output.size() > MAX_BYTES) throw InvalidInput{};
  const auto bytes = uint32_t(output.size());
  for (unsigned i = 0; i < 4; ++i) output[12 + i] = uint8_t(bytes >> (i * 8));
}
#include "core_session.inc"
#include "core_policy.inc"
} // namespace

extern "C" {
uint32_t core_abi_version() { return ABI_VERSION; }
uint32_t core_session_create() {
  try { if (next_session == std::numeric_limits<uint32_t>::max()) return 0; const auto id = ++next_session; sessions.emplace(id, std::make_unique<Session>()); return id; } catch (...) { return 0; }
}
void core_session_destroy(uint32_t id) { sessions.erase(id); }
uint32_t core_session_apply(uint32_t id, const uint8_t* buffer, uint32_t size) {
  return with_session(id, [&](auto& s) { if (!heap_input(buffer, size) || s.business) throw InvalidInput{}; apply_session(s, buffer, size); });
}
uint32_t core_session_configure(uint32_t id, const uint8_t* buffer, uint32_t size) {
  return with_authorized_session(id, [&](auto& s) { if (!heap_input(buffer, size)) throw InvalidInput{}; configure_business(s, buffer, size); });
}
uint32_t core_session_apply_authorized(uint32_t id, const uint8_t* buffer, uint32_t size, uint32_t role) {
  return with_authorized_session(id, [&](auto& s) { if (!heap_input(buffer, size)) throw InvalidInput{}; apply_authorized(s, buffer, size, role); });
}
uint32_t core_session_snapshot(uint32_t id) { return with_authorized_session(id, [&](auto& s) { snapshot_business(s); }); }
uint32_t core_session_checkpoint(uint32_t id) { return with_authorized_session(id, [&](auto& s) { checkpoint_business(s); }); }
uint32_t core_session_restore(uint32_t id, const uint8_t* buffer, uint32_t size) {
  return with_authorized_session(id, [&](auto& s) { if (!heap_input(buffer, size)) throw InvalidInput{}; restore_business(s, buffer, size); });
}
uint32_t core_session_reset(uint32_t id) { return with_session(id, [&](auto& s) {
  if (s.business) { auto next = std::make_shared<BusinessState>(); next->policy = s.business->policy; s.business.swap(next); }
  s.items.clear();
}); }
// Status: 0 success; 1 invalid input/size; 2 allocation failure. No partial output on failure.
uint32_t core_merge(const uint8_t* buffer, uint32_t size) {
  clear_output();
  const auto address = reinterpret_cast<uintptr_t>(buffer);
  const auto heap_size = emscripten_get_heap_size();
  if (!buffer || size < 32 || size > MAX_BYTES || address > heap_size || size > heap_size - address) return 1;
  try { merge(buffer, size); return 0; }
  catch (const InvalidInput&) { clear_output(); return 1; }
  catch (const std::bad_alloc&) { clear_output(); return 2; }
  catch (...) { clear_output(); return 1; }
}
const uint8_t* core_output_ptr() { return output.data(); }
uint32_t core_output_size() { return uint32_t(output.size()); }
void core_clear_output() { clear_output(); }
}
