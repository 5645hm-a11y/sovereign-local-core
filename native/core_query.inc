// Bounded keyset reads over native state. The engine fences pages at a durable revision.
struct QueryRecordTooLarge {};
uint64_t query_text_size(const Text& text) { return 4 + uint64_t(text.size()) * 2; }
uint64_t query_item_size(const Text& id, const OwnedItem& item) {
  uint64_t size = query_text_size(id) + 4;
  for (const auto& [key, reg] : item.fields) {
    size += query_text_size(key) + 4;
    if (reg.value.tag == 3) size += 8;
    else if (reg.value.tag == 4) size += query_text_size(reg.value.text);
  }
  return size;
}
uint64_t query_position_size(const Text& after, const Order& next, bool extended, bool indexed, const OwnedValue& value) {
  return query_text_size(after) + 16 + query_text_size(next.actor) + (extended ? 4 : 0) +
    (indexed ? 4 + (value.tag == 3 ? 8 : value.tag == 4 ? query_text_size(value.text) : 0) : 0);
}
void query_session(Session& session, const uint8_t* bytes, uint32_t size) {
  Reader r{bytes, size};
  if (r.u32() != 0x31525153) throw InvalidInput{};
  const auto version = r.u32(); if (version != 1 && version != 2) throw InvalidInput{};
  const auto mode = r.u32(), limit = r.u32(), budget = r.u32();
  const auto prefix_slice = r.string(), after_slice = r.string();
  const auto clock = r.u64(), sequence = r.u64(); const auto actor_slice = r.string();
  if (mode < 1 || mode > 2 || !limit || limit > 128 || budget < 1024 || budget > 1048576 ||
      (prefix_slice.units && !ascii_identifier(prefix_slice)) || (after_slice.units && !ascii_identifier(after_slice)) ||
      (mode == 1 && (clock || sequence || actor_slice.units)) ||
      (mode == 2 && (prefix_slice.units || after_slice.units || clock > MAX_SAFE || sequence > MAX_SAFE ||
        ((clock || sequence || actor_slice.units) && (!clock || !sequence || !ascii_identifier(actor_slice)))))) throw InvalidInput{};
  const Text prefix = owned(prefix_slice); Text after = owned(after_slice), sort_field;
  Order next{clock, sequence, owned(actor_slice)}; OwnedValue sort_after; sort_after.tag = 5;
  std::vector<QueryFilter> filters; bool has_sort = false, descending = false;
  if (version == 2) {
    const auto count = r.u32(), force_scan = r.u32(); if (mode != 1 || count > 4 || force_scan > 1) throw InvalidInput{};
    for (uint32_t i = 0; i < count; i++) {
      const auto name = r.string(); const auto op = r.u32();
      if (!query_field_valid(name) || op < 1 || op > 5) throw InvalidInput{};
      auto value = read_query_value(r);
      if (op != 1 && value.tag != 3 && value.tag != 4) throw InvalidInput{};
      filters.push_back(QueryFilter{owned(name), op, std::move(value)});
    }
    const auto name = r.string(); const auto direction = r.u32();
    if ((name.units && !query_field_valid(name)) || direction > 1 || (!name.units && direction) || (force_scan && name.units)) throw InvalidInput{};
    sort_field = owned(name); descending = direction == 1;
    // A leading equality bucket has ID order, so it also accelerates unordered AND queries.
    if (sort_field.empty() && !force_scan) for (const auto& f : filters) if (f.op == 1) { sort_field = f.field; break; }
    const auto flag = r.u32(); if (flag > 1) throw InvalidInput{}; has_sort = flag == 1;
    if (has_sort) sort_after = read_query_value(r, true);
    if ((!sort_field.empty() && !after.empty()) != has_sort || (has_sort && !after.starts_with(prefix))) throw InvalidInput{};
  }
  if (r.offset != r.size) throw InvalidInput{};
  append32(0x31505153); append32(version); append32(mode); append32(0); append32(0); append32(0); append32(0);
  if (version == 2) { append32(0); append32(0); } // Cold-build scanned entries and logical key bytes.
  uint32_t count = 0, scanned = 0, built = 0, key_bytes = 0; bool done = true;
  if (mode == 1 && !sort_field.empty()) {
    const auto bounds = query_bounds(filters, sort_field);
    if (!bounds.impossible) {
      if (has_sort && !query_in_bounds(sort_after, bounds)) throw InvalidInput{};
      auto index = query_index(session, prefix, sort_field, built); key_bytes = index->key_bytes;
      const auto& rows = index->rows; const Text high_id(1, char16_t(0xffff));
      auto begin = rows.begin(), end = rows.end();
      if (bounds.lower) begin = bounds.lower_closed ? index->lower_bound(IndexKey{bounds.lo, {}}) : index->upper_bound(IndexKey{bounds.lo, high_id});
      else if (bounds.upper) {
        OwnedValue minimum; minimum.tag = bounds.hi.tag; if (minimum.tag == 3) minimum.number = -std::numeric_limits<double>::max();
        begin = index->lower_bound(IndexKey{minimum, {}});
      }
      if (bounds.upper) end = bounds.upper_closed ? index->upper_bound(IndexKey{bounds.hi, high_id}) : index->lower_bound(IndexKey{bounds.hi, {}});
      else if (bounds.lower) { OwnedValue next_type; next_type.tag = bounds.lo.tag + 1; end = index->lower_bound(IndexKey{next_type, {}}); }
      const auto scan = [&](auto it, auto finish) {
        for (; it != finish; ++it) {
          if (scanned == 256 || count == limit) { done = false; break; }
          const auto& entry = *it; const auto item = entry.item;
          const auto& id = *entry.id; const auto& value = *entry.value;
          const bool matched = query_matches(*item, filters);
          const auto trailer = query_position_size(id, next, true, true, value);
          if (output.size() + trailer + (matched ? query_item_size(id, *item) : 0) > budget) {
            if (!scanned) throw QueryRecordTooLarge{}; done = false; break;
          }
          if (matched) {
            append_text(id); append32(uint32_t(item->fields.size()));
            for (const auto& [name, reg] : item->fields) { append_text(name); append_value(reg.value); }
            ++count;
          }
          ++scanned; after = id; sort_after = value; has_sort = true;
        }
      };
      if (!descending) scan(has_sort ? index->upper_bound(IndexKey{sort_after, after}) : begin, end);
      else scan(std::make_reverse_iterator(has_sort ? index->lower_bound(IndexKey{sort_after, after}) : end), std::make_reverse_iterator(begin));
    }
  } else if (mode == 1) {
    auto it = after.empty() ? session.items.lower_bound(prefix) : session.items.upper_bound(after);
    for (; it != session.items.end() && it->first.starts_with(prefix); ++it) {
      if (scanned == 256 || count == limit) { done = false; break; }
      const auto& [id, item] = *it;
      if (item.present && query_matches(item, filters)) {
        const auto trailer = version == 1 ? 512 : query_position_size(id, next, true, false, sort_after);
        if (query_item_size(id, item) + output.size() + trailer > budget) {
          if (!count) throw QueryRecordTooLarge{}; done = false; break;
        }
        append_text(id); append32(uint32_t(item.fields.size()));
        for (const auto& [key, reg] : item.fields) { append_text(key); append_value(reg.value); }
        ++count;
      }
      ++scanned; after = id;
    }
  } else if (session.business) {
    Candidate probe; probe.command.order = next;
    const auto& decisions = session.business->decisions;
    auto it = clock ? decisions.upper_bound(&probe) : decisions.begin();
    for (; it != decisions.end(); ++it) {
      if (count == limit) { done = false; break; }
      const auto& [candidate, decision] = *it;
      if (query_text_size(decision.id) + query_text_size(decision.item) + 8 + output.size() + 512 > budget) {
        if (!count) throw QueryRecordTooLarge{}; done = false; break;
      }
      append_text(decision.id); append_text(decision.item); append32(decision.type); append32(decision.status);
      next = candidate->command.order; ++count; ++scanned;
    }
  }
  append_text(after); append64(next.clock); append64(next.sequence); append_text(next.actor);
  if (version == 2) { append32(has_sort ? 1 : 0); if (has_sort) append_value(sort_after); }
  for (unsigned i = 0; i < 4; ++i) {
    output[12 + i] = uint8_t(count >> (i * 8)); output[20 + i] = uint8_t(uint32_t(done) >> (i * 8)); output[24 + i] = uint8_t(scanned >> (i * 8));
    if (version == 2) { output[28 + i] = uint8_t(built >> (i * 8)); output[32 + i] = uint8_t(key_bytes >> (i * 8)); }
  }
  if (output.size() > budget) throw InvalidInput{};
  const auto total = uint32_t(output.size()); for (unsigned i = 0; i < 4; ++i) output[16 + i] = uint8_t(total >> (i * 8));
}
