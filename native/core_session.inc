// Stateful ABI extension. Owned registers survive input arena reuse; checkpoints include tombstones.
using Text = std::u16string;
Text owned(Slice s) { Text value(s.units, 0); for (uint32_t i = 0; i < s.units; ++i) value[i] = code_unit(s, i); return value; }
struct OwnedStamp { uint64_t lamport = 0, sequence = 0; std::shared_ptr<const Text> actor; };
bool later(const OwnedStamp& a, const OwnedStamp& b) {
  if (a.lamport != b.lamport) return a.lamport > b.lamport;
  if (!b.actor) return bool(a.actor);
  if (*a.actor != *b.actor) return *a.actor > *b.actor;
  return a.sequence > b.sequence;
}
struct OwnedValue { uint32_t tag = 0; double number = 0; Text text; Slice pending_text; bool borrowed = false; };
struct OwnedRegister { OwnedStamp stamp; OwnedValue value; };
struct OwnedItem { OwnedStamp existence; bool present = false; std::map<Text, OwnedRegister> fields; };
using State = std::map<Text, OwnedItem>;
using ActorCache = std::unordered_map<Slice, std::shared_ptr<const Text>, SliceHash, SliceEqual>;
struct BusinessState;
struct QueryIndexes;
struct Session { State items; std::shared_ptr<BusinessState> business; std::shared_ptr<QueryIndexes> query_indexes; };
template<class ChangedRows> void update_query_indexes(Session&, const State&, const ChangedRows&);
std::unordered_map<uint32_t, std::unique_ptr<Session>> sessions;
uint32_t next_session = 0;
bool heap_input(const uint8_t* p, uint32_t size) {
  const auto at = reinterpret_cast<uintptr_t>(p), heap = emscripten_get_heap_size();
  return p && size >= 16 && size <= MAX_BYTES && at <= heap && size <= heap - at;
}
void append_text(const Text& s) {
  if (output.size() + 4 + s.size() * 2 > MAX_BYTES) throw InvalidInput{};
  append32(uint32_t(s.size())); for (const auto c : s) { output.push_back(uint8_t(c)); output.push_back(uint8_t(c >> 8)); }
}
void append64(uint64_t n) { append32(uint32_t(n)); append32(uint32_t(n >> 32)); }
void append_value(const OwnedValue& v) {
  append32(v.tag);
  if (v.tag == 3) { uint64_t bits; std::memcpy(&bits, &v.number, 8); append64(bits); }
  else if (v.tag == 4) append_text(v.text);
}
void output_size() {
  if (output.size() > MAX_BYTES) throw InvalidInput{};
  const auto size = uint32_t(output.size()); for (unsigned i = 0; i < 4; ++i) output[12 + i] = uint8_t(size >> (i * 8));
}
void stage_block(State& base, State& changes, ActorCache& actor_cache, const uint8_t* buffer, uint32_t size) {
  Reader r{buffer, size};
  if (r.u32() != INPUT_MAGIC || r.u32() != 1) throw InvalidInput{};
  const auto count = r.u32(), declared = r.u32(), ac = r.u32(), ic = r.u32(), kc = r.u32(), dictionary_at = r.u32();
  if (declared != size || dictionary_at < 32 || dictionary_at > size || count > MAX_EVENTS) throw InvalidInput{};
  Reader d{buffer + dictionary_at, size - dictionary_at};
  const auto actors = dictionary(d, ac, 0), ids = dictionary(d, ic, 1), keys = dictionary(d, kc, 2);
  if (d.offset != d.size) throw InvalidInput{};
  r.size = dictionary_at;
  if (count > (r.size - r.offset) / 32) throw InvalidInput{};
  std::array<uint32_t, 16> small{}; std::unordered_set<uint32_t> large;
  for (uint32_t i = 0; i < count; ++i) {
    const auto clock = r.u64(), sequence = r.u64();
    const auto actor = r.u32(), id = r.u32(), type = r.u32(), fields = r.u32();
    if (!clock || clock > MAX_SAFE || !sequence || sequence > MAX_SAFE || actor >= ac || id >= ic || type < 1 || type > 3 || fields > kc || (type == 3 && fields)) throw InvalidInput{};
    auto cached_actor = actor_cache.find(actors[actor]);
    if (cached_actor == actor_cache.end()) cached_actor = actor_cache.emplace(actors[actor], std::make_shared<const Text>(owned(actors[actor]))).first;
    const OwnedStamp stamp{clock, sequence, cached_actor->second};
    const auto name = owned(ids[id]);
    auto change = changes.find(name);
    if (change == changes.end()) { const auto old = base.find(name); change = changes.emplace(name, old == base.end() ? OwnedItem{} : old->second).first; }
    auto& item = change->second;
    if (type != 2 && later(stamp, item.existence)) { item.existence = stamp; item.present = type == 1; }
    if (fields > small.size()) large.clear();
    for (uint32_t f = 0; f < fields; ++f) {
      const auto key = r.u32(), tag = r.u32(); if (key >= kc || tag > 4) throw InvalidInput{};
      if (fields <= small.size()) { for (uint32_t p = 0; p < f; ++p) if (small[p] == key) throw InvalidInput{}; small[f] = key; }
      else if (!large.insert(key).second) throw InvalidInput{};
      double number = 0; Slice text;
      if (tag == 3) number = r.f64(); else if (tag == 4) text = r.string();
      const auto field_name = owned(keys[key]);
      auto reg = item.fields.find(field_name);
      if (reg == item.fields.end() || later(stamp, reg->second.stamp)) {
        OwnedValue value; value.tag = tag; value.number = number == 0 ? 0 : number; // Existing command normalization maps -0 to +0.
        if (tag == 4) { value.pending_text = text; value.borrowed = true; }
        item.fields.insert_or_assign(field_name, OwnedRegister{stamp, std::move(value)});
      }
    }
  }
  if (r.offset != r.size) throw InvalidInput{};
}
void apply_session(Session& session, const uint8_t* bytes, uint32_t size) {
  Reader r{bytes, size}; const auto magic = r.u32(); State changes; ActorCache actors;
  if (magic == INPUT_MAGIC) stage_block(session.items, changes, actors, bytes, size);
  else {
    if (magic != 0x31424353 || r.u32() != 1) throw InvalidInput{}; // SCB1 batch of independent ABI-1 blocks.
    const auto count = r.u32(); if (r.u32() != size || count > MAX_EVENTS || count > (size - 16) / 36) throw InvalidInput{};
    for (uint32_t i = 0; i < count; ++i) { const auto n = r.u32(); stage_block(session.items, changes, actors, r.take(n), n); }
    if (r.offset != r.size) throw InvalidInput{};
  }
  // Copy only final winning strings before committing; source slices never escape the call.
  for (auto& [id, item] : changes) for (auto& [key, reg] : item.fields) if (reg.value.borrowed) {
    reg.value.text = owned(reg.value.pending_text); reg.value.pending_text = {}; reg.value.borrowed = false;
  }
  update_query_indexes(session, changes, changes);
  // All parsing, allocation and register updates precede publication. Node transfer allocates nothing.
  while (!changes.empty()) { auto node = changes.extract(changes.begin()); session.items.erase(node.key()); session.items.insert(std::move(node)); }
}
void snapshot_session(const Session& s) {
  uint32_t count = 0; for (const auto& [id, item] : s.items) if (item.present) ++count;
  append32(0x31564f53); append32(1); append32(count); append32(0); // SOV1: self-contained query view.
  for (const auto& [id, item] : s.items) if (item.present) {
    append_text(id); append32(uint32_t(item.fields.size()));
    for (const auto& [key, reg] : item.fields) { append_text(key); append_value(reg.value); }
  }
  output_size();
}
void write_stamp(const OwnedStamp& s) { append64(s.lamport); append64(s.sequence); append_text(s.actor ? *s.actor : Text{}); }
OwnedStamp read_stamp(Reader& r, bool optional) {
  const auto clock = r.u64(), seq = r.u64(); const auto actor = r.string();
  if (!clock && !seq && !actor.units && optional) return {};
  if (!clock || clock > MAX_SAFE || !seq || seq > MAX_SAFE || !ascii_identifier(actor)) throw InvalidInput{};
  return {clock, seq, std::make_shared<const Text>(owned(actor))};
}
void checkpoint_session(const Session& s) {
  append32(0x314b4353); append32(1); append32(uint32_t(s.items.size())); append32(0); // SCK1
  for (const auto& [id, item] : s.items) {
    append_text(id); append32(item.present ? 1 : 0); write_stamp(item.existence); append32(uint32_t(item.fields.size()));
    for (const auto& [key, reg] : item.fields) { append_text(key); write_stamp(reg.stamp); append_value(reg.value); }
  }
  output_size();
}
State restore_session(const uint8_t* bytes, uint32_t size) {
  Reader r{bytes, size}; if (r.u32() != 0x314b4353 || r.u32() != 1) throw InvalidInput{};
  const auto count = r.u32(); if (r.u32() != size || count > MAX_EVENTS || count > (size - 16) / 36) throw InvalidInput{};
  State state;
  for (uint32_t i = 0; i < count; ++i) {
    const auto id = r.string(); if (!ascii_identifier(id)) throw InvalidInput{};
    OwnedItem item; const auto present = r.u32(); if (present > 1) throw InvalidInput{}; item.present = present == 1;
    item.existence = read_stamp(r, true); if (item.present && !item.existence.actor) throw InvalidInput{};
    const auto fields = r.u32(); if (fields > MAX_EVENTS || fields > (r.size - r.offset) / 32) throw InvalidInput{};
    for (uint32_t f = 0; f < fields; ++f) {
      const auto key = r.string(); if (!key.units || key.units > 128 || matches(key, "__proto__") || matches(key, "constructor") || matches(key, "prototype")) throw InvalidInput{};
      auto stamp = read_stamp(r, false); OwnedValue value; value.tag = r.u32(); if (value.tag > 4) throw InvalidInput{};
      if (value.tag == 3) value.number = r.f64(); else if (value.tag == 4) value.text = owned(r.string());
      if (!item.fields.emplace(owned(key), OwnedRegister{std::move(stamp), std::move(value)}).second) throw InvalidInput{};
    }
    if (!state.emplace(owned(id), std::move(item)).second) throw InvalidInput{};
  }
  if (r.offset != r.size) throw InvalidInput{}; return state;
}
template<class F> uint32_t with_session(uint32_t handle, F fn) {
  clear_output(); const auto s = sessions.find(handle); if (s == sessions.end()) return 1;
  try { fn(*s->second); return 0; }
  catch (const std::bad_alloc&) { clear_output(); return 2; }
  catch (...) { clear_output(); return 1; }
}
