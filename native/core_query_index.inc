// Local, disposable field indexes. They reference only the currently published native rows.
struct QueryIndexLimit {};
struct QueryFilter { Text field; uint32_t op; OwnedValue value; };
int query_value_compare(const OwnedValue& a, const OwnedValue& b) {
  if (a.tag != b.tag) return a.tag < b.tag ? -1 : 1;
  if (a.tag == 3) return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
  if (a.tag == 4) return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  return 0;
}
struct IndexKey { OwnedValue value; Text id; };
struct IndexedRow { const OwnedValue* value; const Text* id; const OwnedItem* item; };
const OwnedValue QUERY_MISSING = [] { OwnedValue v; v.tag = 5; return v; }();
struct IndexedLess {
  bool operator()(const IndexedRow& a, const IndexedRow& b) const { const auto cmp = query_value_compare(*a.value, *b.value); return cmp ? cmp < 0 : *a.id < *b.id; }
  bool operator()(const IndexedRow& a, const IndexKey& b) const { const auto cmp = query_value_compare(*a.value, b.value); return cmp ? cmp < 0 : *a.id < b.id; }
  bool operator()(const IndexKey& a, const IndexedRow& b) const { const auto cmp = query_value_compare(a.value, *b.value); return cmp ? cmp < 0 : a.id < *b.id; }
};
struct QueryValueLess { bool operator()(const OwnedValue* a, const OwnedValue* b) const { return query_value_compare(*a, *b) < 0; } };
struct FieldIndex {
  // No row, field, value string or ID is copied. Delta publication rewires replaced references.
  std::vector<IndexedRow> rows; uint32_t scanned = 0, key_bytes = 0;
  auto lower_bound(const IndexKey& key) const { return std::lower_bound(rows.begin(), rows.end(), key, IndexedLess{}); }
  auto upper_bound(const IndexKey& key) const { return std::upper_bound(rows.begin(), rows.end(), key, IndexedLess{}); }
};
struct QueryIndexes {
  struct Entry { std::shared_ptr<FieldIndex> index; uint64_t used; };
  std::map<std::pair<Text, Text>, Entry> fields; uint64_t tick = 0;
};
uint64_t query_key_bytes(const IndexedRow& row) {
  const auto& value = *row.value;
  return sizeof(IndexedRow) + 4 + row.id->size() * 2 + 4 + (value.tag == 3 ? 8 : value.tag == 4 ? 4 + value.text.size() * 2 : 0);
}
IndexedRow query_row(const State::value_type& entry, const Text& field_name) {
  const auto found = entry.second.fields.find(field_name);
  return {found == entry.second.fields.end() ? &QUERY_MISSING : &found->second.value, &entry.first, &entry.second};
}
// Indexes are derived caches, not replicated state. Stage all allocations before touching
// any cache or row; then apply pointer-only edits while old and new row nodes are alive.
// Map node transfer preserves the addresses of the staged replacement rows.
template<class ChangedRows> void update_query_indexes(Session& session, const State& changes, const ChangedRows& affected) {
  if (!session.query_indexes) return;
  struct Patch {
    std::shared_ptr<FieldIndex> index;
    std::vector<size_t> removed;
    std::vector<IndexedRow> added;
    std::vector<std::pair<size_t, IndexedRow>> relinked;
    uint32_t scanned = 0, bytes = 0;
    bool drop = false;
  };
  auto& fields = session.query_indexes->fields;
  std::vector<std::pair<decltype(fields.begin()), Patch>> patches; patches.reserve(fields.size());
  for (auto cached = fields.begin(); cached != fields.end(); ++cached) {
    const auto& [prefix, field_name] = cached->first; auto index = cached->second.index;
    Patch patch; patch.index = index;
    uint64_t bytes = index->key_bytes; int64_t scanned = index->scanned; uint32_t count = 0;
    for (const auto& [id, unused] : affected) if (id.starts_with(prefix)) {
      // Large batches invalidate only matching caches rather than doing k*n vector edits.
      if (++count > 256) { patch.drop = true; break; }
      const auto old = session.items.find(id); const auto next = changes.find(id);
      scanned += int(next != changes.end()) - int(old != session.items.end());
      const bool had = old != session.items.end() && old->second.present;
      const bool has = next != changes.end() && next->second.present;
      size_t at = 0; IndexedRow previous{}, replacement{};
      if (had) {
        previous = query_row(*old, field_name);
        // Search with borrowed keys: no indexed string or item ID is copied.
        const auto found = std::lower_bound(index->rows.begin(), index->rows.end(), previous, IndexedLess{});
        if (found == index->rows.end() || found->item != previous.item) throw InvalidInput{};
        at = size_t(found - index->rows.begin()); bytes -= query_key_bytes(previous);
      }
      if (has) {
        replacement = query_row(*next, field_name);
        if (replacement.value->tag == 4 && replacement.value->text.size() > 1024) { patch.drop = true; break; }
        bytes += query_key_bytes(replacement);
      }
      if (had && has && !query_value_compare(*previous.value, *replacement.value)) patch.relinked.emplace_back(at, replacement);
      else { if (had) patch.removed.push_back(at); if (has) patch.added.push_back(replacement); }
    }
    if (!count) continue;
    if (scanned > 100000 || bytes > 16 * 1024 * 1024) patch.drop = true;
    if (!patch.drop) {
      patch.scanned = uint32_t(scanned); patch.bytes = uint32_t(bytes);
      std::sort(patch.removed.begin(), patch.removed.end());
      std::sort(patch.added.begin(), patch.added.end(), IndexedLess{});
      // Reserve in the staging phase; reserve changes capacity only, never contents.
      index->rows.reserve(index->rows.size() - patch.removed.size() + patch.added.size());
    }
    patches.emplace_back(cached, std::move(patch));
  }
  // No allocations or throwing operations remain. Existing cursors still invalidate
  // on durable revision changes; retaining this cache does not create MVCC snapshots.
  for (auto& [cached, patch] : patches) {
    if (patch.drop) { fields.erase(cached); continue; }
    auto& rows = patch.index->rows;
    for (const auto& [at, replacement] : patch.relinked) rows[at] = replacement;
    if (!patch.removed.empty()) {
      size_t dst = patch.removed.front(), src = dst + 1;
      for (size_t i = 1; i < patch.removed.size(); ++i) {
        const auto end = patch.removed[i];
        std::move(rows.begin() + src, rows.begin() + end, rows.begin() + dst);
        dst += end - src; src = end + 1;
      }
      std::move(rows.begin() + src, rows.end(), rows.begin() + dst);
      rows.resize(dst + rows.size() - src);
    }
    size_t old = rows.size(), added = patch.added.size(), out = old + added;
    rows.resize(out);
    while (added) {
      // Seek each insertion with logarithmic comparisons, then shift a block of
      // pointer records. A moved suffix must not compare every row's string key.
      const auto at = size_t(std::lower_bound(rows.begin(), rows.begin() + old, patch.added[added - 1], IndexedLess{}) - rows.begin());
      const auto shifted = old - at;
      std::move_backward(rows.begin() + at, rows.begin() + old, rows.begin() + out);
      out -= shifted; old = at; rows[--out] = patch.added[--added];
    }
    patch.index->scanned = patch.scanned; patch.index->key_bytes = patch.bytes;
  }
}
bool query_field_valid(Slice field) {
  return field.units && field.units <= 128 && !matches(field, "__proto__") && !matches(field, "constructor") && !matches(field, "prototype");
}
OwnedValue read_query_value(Reader& r, bool missing = false) {
  OwnedValue value; value.tag = r.u32();
  if (value.tag > (missing ? 5u : 4u)) throw InvalidInput{};
  if (value.tag == 3) { value.number = r.f64(); if (value.number == 0) value.number = 0; }
  else if (value.tag == 4) { const auto text = r.string(); if (text.units > 1024) throw InvalidInput{}; value.text = owned(text); }
  return value;
}
bool query_matches(const OwnedItem& item, const std::vector<QueryFilter>& filters) {
  for (const auto& f : filters) {
    const auto value = field(item, f.field);
    if (!value || value->tag != f.value.tag) return false; // Missing is distinct from null; ranges do not coerce types.
    const auto cmp = query_value_compare(*value, f.value);
    if (f.op == 1 ? cmp != 0 : f.op == 2 ? cmp <= 0 : f.op == 3 ? cmp < 0 : f.op == 4 ? cmp >= 0 : cmp > 0) return false;
  }
  return true;
}
std::shared_ptr<FieldIndex> query_index(Session& session, const Text& prefix, const Text& field_name, uint32_t& built) {
  const auto key = std::make_pair(prefix, field_name);
  if (session.query_indexes) {
    const auto found = session.query_indexes->fields.find(key);
    if (found != session.query_indexes->fields.end()) { found->second.used = ++session.query_indexes->tick; return found->second.index; }
  }
  auto index = std::make_shared<FieldIndex>(); uint64_t bytes = 0; bool ordered = true;
  for (auto it = session.items.lower_bound(prefix); it != session.items.end() && it->first.starts_with(prefix); ++it) {
    if (++index->scanned > 100000) throw QueryIndexLimit{};
    const auto& [id, item] = *it; if (!item.present) continue;
    const auto row = query_row(*it, field_name);
    if (row.value->tag == 4 && row.value->text.size() > 1024) throw QueryIndexLimit{};
    bytes += query_key_bytes(row);
    if (bytes > 16 * 1024 * 1024) throw QueryIndexLimit{};
    if (!index->rows.empty() && IndexedLess{}(row, index->rows.back())) ordered = false;
    index->rows.push_back(row);
  }
  if (!ordered) {
    // Low-cardinality fields (status, category, booleans) need only a small value directory.
    // Stable bucket placement preserves source ID order without n*log(n) string comparisons.
    std::map<const OwnedValue*, uint32_t, QueryValueLess> groups;
    for (const auto& row : index->rows) { groups.try_emplace(row.value, 0); if (groups.size() > 256) break; }
    if (groups.size() <= 256) {
      uint32_t rank = 0; for (auto& [value, n] : groups) n = rank++;
      std::vector<uint32_t> ranks, offsets(groups.size()); ranks.reserve(index->rows.size());
      for (const auto& row : index->rows) { const auto n = groups.at(row.value); ranks.push_back(n); offsets[n]++; }
      uint32_t total = 0; for (auto& offset : offsets) { const auto count = offset; offset = total; total += count; }
      std::vector<IndexedRow> sorted(index->rows.size());
      for (size_t i = 0; i < index->rows.size(); ++i) sorted[offsets[ranks[i]]++] = index->rows[i];
      index->rows.swap(sorted);
    } else std::sort(index->rows.begin(), index->rows.end(), IndexedLess{});
  }
  index->key_bytes = uint32_t(bytes);
  // Fully build before replacing/evicting a cache. A failed build never changes published rows.
  if (!session.query_indexes) session.query_indexes = std::make_shared<QueryIndexes>();
  auto& cache = *session.query_indexes;
  cache.fields.emplace(key, QueryIndexes::Entry{index, ++cache.tick});
  if (cache.fields.size() > 2) {
    auto oldest = cache.fields.begin(); for (auto it = cache.fields.begin(); it != cache.fields.end(); ++it) if (it->second.used < oldest->second.used) oldest = it;
    cache.fields.erase(oldest);
  }
  built = index->scanned; return index;
}
struct QueryBounds {
  bool impossible = false, lower = false, upper = false, lower_closed = false, upper_closed = false;
  OwnedValue lo, hi;
};
QueryBounds query_bounds(const std::vector<QueryFilter>& filters, const Text& indexed_field) {
  QueryBounds b; uint32_t tag = 6;
  for (const auto& f : filters) if (f.field == indexed_field) {
    if (tag != 6 && tag != f.value.tag) b.impossible = true; tag = f.value.tag;
    if (f.op <= 3) {
      const bool closed = f.op != 2; const auto cmp = b.lower ? query_value_compare(f.value, b.lo) : 1;
      if (cmp > 0) { b.lo = f.value; b.lower = true; b.lower_closed = closed; }
      else if (!cmp) b.lower_closed = b.lower_closed && closed;
    }
    if (f.op == 1 || f.op >= 4) {
      const bool closed = f.op != 4; const auto cmp = b.upper ? query_value_compare(f.value, b.hi) : -1;
      if (cmp < 0) { b.hi = f.value; b.upper = true; b.upper_closed = closed; }
      else if (!cmp) b.upper_closed = b.upper_closed && closed;
    }
  }
  if (b.lower && b.upper) { const auto cmp = query_value_compare(b.lo, b.hi); if (cmp > 0 || (!cmp && (!b.lower_closed || !b.upper_closed))) b.impossible = true; }
  return b;
}
bool query_in_bounds(const OwnedValue& v, const QueryBounds& b) {
  if (b.lower) { const auto cmp = query_value_compare(v, b.lo); if (v.tag != b.lo.tag || cmp < 0 || (!cmp && !b.lower_closed)) return false; }
  if (b.upper) { const auto cmp = query_value_compare(v, b.hi); if (v.tag != b.hi.tag || cmp > 0 || (!cmp && !b.upper_closed)) return false; }
  return !b.impossible;
}
