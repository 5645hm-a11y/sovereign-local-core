// Additive policy/state-machine ABI. Only Web-Crypto-verified roles cross this boundary.
// Keep every candidate: an earlier Lamport event may invalidate a previous winner.
struct PolicyDenied {};
struct Rule { Text prefix, owner; bool library; std::array<uint32_t, 5> masks; };
struct Policies { bool default_allow; std::vector<Rule> rules; std::vector<uint8_t> bytes; };
struct Order {
  uint64_t clock, sequence; Text actor;
  bool operator<(const Order& b) const { return clock != b.clock ? clock < b.clock : actor != b.actor ? actor < b.actor : sequence < b.sequence; }
};
struct Command { Order order; Text item; uint32_t type, role; std::map<Text, OwnedValue> fields; };
struct Candidate { Command command; std::vector<uint8_t> bytes; };
struct Decision { Text id, item; uint32_t type, status; };
struct BusinessState {
  Policies policy;
  std::map<Order, Candidate> history;
  std::map<Text, Order> identities;
  std::vector<Decision> decisions;
  uint32_t byte_count = 0;
};
constexpr uint32_t MAX_POLICY_EVENTS = 100000;
Text event_id(const Order& o) {
  const auto seq = std::to_string(o.sequence); return o.actor + u":" + Text(seq.begin(), seq.end());
}
Policies read_policies(const uint8_t* bytes, uint32_t size) {
  Reader r{bytes, size}; if (r.u32() != 0x31504353 || r.u32() != 1) throw InvalidInput{};
  const auto count = r.u32(), allow = r.u32(); if (count > 32 || allow > 1) throw InvalidInput{};
  Policies p{allow == 1, {}, std::vector<uint8_t>(bytes, bytes + size)};
  std::unordered_set<Text> prefixes;
  for (uint32_t i = 0; i < count; ++i) {
    const auto prefix = r.string(), owner = r.string(); const auto library = r.u32();
    if (!ascii_identifier(prefix) || (owner.units && (!ascii_identifier(owner) || matches(owner, "__proto__") || matches(owner, "constructor") || matches(owner, "prototype") || matches(owner, "loanId") || matches(owner, "borrowerId") || matches(owner, "checkedOutBy"))) || library > 1) throw InvalidInput{};
    Rule rule{owned(prefix), owned(owner), library == 1, {}};
    if (!prefixes.insert(rule.prefix).second) throw InvalidInput{};
    for (auto& mask : rule.masks) { mask = r.u32(); if (mask > 7) throw InvalidInput{}; }
    if (!rule.library && (rule.masks[3] || rule.masks[4])) throw InvalidInput{};
    p.rules.push_back(std::move(rule));
  }
  if (r.offset != r.size) throw InvalidInput{}; return p;
}
Command read_command(const uint8_t* bytes, uint32_t size, uint32_t role) {
  Reader r{bytes, size}; if (r.u32() != INPUT_MAGIC) throw InvalidInput{};
  const auto abi = r.u32(), count = r.u32(), declared = r.u32(), ac = r.u32(), ic = r.u32(), kc = r.u32(), at = r.u32();
  if ((abi != 1 && abi != 2) || count != 1 || declared != size || ac != 1 || ic != 1 || at < 64 || at > size || role < 1 || role > 3) throw InvalidInput{};
  Reader d{bytes + at, size - at}; const auto actors = dictionary(d, ac, 0), ids = dictionary(d, ic, 1), keys = dictionary(d, kc, 2);
  if (d.offset != d.size) throw InvalidInput{}; r.size = at;
  const auto clock = r.u64(), sequence = r.u64();
  const auto actor = r.u32(), id = r.u32(), type = r.u32(), count_fields = r.u32();
  if (!clock || clock > MAX_SAFE || !sequence || sequence > MAX_SAFE || actor || id || type < 1 || type > 5 ||
      (type > 3 ? abi != 2 : abi != 1) || count_fields > kc || (type == 3 && count_fields)) throw InvalidInput{};
  Command c{{clock, sequence, owned(actors[0])}, owned(ids[0]), type, role, {}};
  for (uint32_t i = 0; i < count_fields; ++i) {
    const auto key = r.u32(), tag = r.u32(); if (key >= kc || tag > 4) throw InvalidInput{};
    OwnedValue value; value.tag = tag;
    if (tag == 3) { const auto number = r.f64(); value.number = number == 0 ? 0 : number; } else if (tag == 4) value.text = owned(r.string());
    if (!c.fields.emplace(owned(keys[key]), std::move(value)).second) throw InvalidInput{};
  }
  if (r.offset != r.size) throw InvalidInput{};
  if (type == 4 || type == 5) {
    const auto field = c.fields.find(type == 4 ? u"borrowerId" : u"checkoutId");
    if (c.fields.size() != 1 || field == c.fields.end() || field->second.tag != 4 || field->second.text.empty() || field->second.text.size() > 128) throw InvalidInput{};
    if (type == 4) for (const auto ch : field->second.text) if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-')) throw InvalidInput{};
  }
  return c;
}
const Rule* matching_rule(const Policies& p, const Text& item) {
  const Rule* best = nullptr;
  for (const auto& rule : p.rules) if (item.starts_with(rule.prefix) && (!best || rule.prefix.size() > best->prefix.size())) best = &rule;
  return best;
}
void authorize_command(const Policies& p, const Command& c) {
  const auto rule = matching_rule(p, c.item);
  if (!rule) { if (!p.default_allow || c.type > 3) throw PolicyDenied{}; return; }
  if (!(rule->masks[c.type - 1] & (1u << (c.role - 1))) || (c.type > 3 && !rule->library)) throw PolicyDenied{};
  if (rule->library && c.type < 3) for (const auto key : {u"loanId", u"borrowerId", u"checkedOutBy"}) if (c.fields.contains(key)) throw PolicyDenied{};
  if (!rule->owner.empty() && c.role != 1) {
    const auto owner = c.fields.find(rule->owner);
    if ((c.type == 1 && owner == c.fields.end()) || (owner != c.fields.end() && (owner->second.tag != 4 || owner->second.text != c.order.actor))) throw PolicyDenied{};
  }
}
const OwnedValue* field(const OwnedItem& item, const Text& key) { const auto f = item.fields.find(key); return f == item.fields.end() ? nullptr : &f->second.value; }
bool borrowed(const OwnedItem& item) { const auto loan = field(item, u"loanId"); return loan && loan->tag == 4 && !loan->text.empty(); }
void set_field(OwnedItem& item, const Text& key, OwnedValue value, const OwnedStamp& stamp) { item.fields.insert_or_assign(key, OwnedRegister{stamp, std::move(value)}); }
void set_text(OwnedItem& item, const Text& key, const Text& value, const OwnedStamp& stamp) { OwnedValue v; v.tag = 4; v.text = value; set_field(item, key, std::move(v), stamp); }
void clear_loan(OwnedItem& item, const OwnedStamp& stamp) { for (const auto key : {u"loanId", u"borrowerId", u"checkedOutBy"}) set_field(item, key, OwnedValue{}, stamp); }
uint32_t reduce_command(State& state, const Policies& policies, const Command& c) {
  const auto rule = matching_rule(policies, c.item);
  const auto found = state.find(c.item);
  const auto old = found == state.end() ? nullptr : &found->second;
  if (rule && !rule->owner.empty() && c.role != 1) {
    const auto owner = old ? field(*old, rule->owner) : nullptr;
    if ((owner && (owner->tag != 4 || owner->text != c.order.actor)) || (!owner && c.type != 1)) return 3; // REJECTED_POLICY
  }
  if (c.type > 3 && (!old || !old->present)) return 2;
  if (rule && rule->library && c.type == 3 && old && borrowed(*old)) return 2;
  if (c.type == 4 && borrowed(*old)) return 2;
  if (c.type == 5) {
    const auto loan = field(*old, u"loanId");
    if (!loan || loan->tag != 4 || loan->text != c.fields.at(u"checkoutId").text) return 2;
  }
  auto& item = state[c.item]; const OwnedStamp stamp{c.order.clock, c.order.sequence, std::make_shared<const Text>(c.order.actor)};
  if (c.type == 4) {
    set_text(item, u"loanId", event_id(c.order), stamp); set_text(item, u"borrowerId", c.fields.at(u"borrowerId").text, stamp); set_text(item, u"checkedOutBy", c.order.actor, stamp);
  } else if (c.type == 5) clear_loan(item, stamp);
  else {
    if (c.type != 2) { item.existence = stamp; item.present = c.type == 1; }
    for (const auto& [key, value] : c.fields) set_field(item, key, value, stamp);
    if (rule && rule->library && c.type == 1 && !item.fields.contains(u"loanId")) clear_loan(item, stamp);
  }
  return 1;
}
State replay_business(BusinessState& business) {
  State state; std::vector<Decision> decisions;
  for (const auto& [order, candidate] : business.history) {
    const auto& c = candidate.command; authorize_command(business.policy, c);
    const auto status = reduce_command(state, business.policy, c);
    if (c.type > 3 || status != 1) decisions.push_back({event_id(order), c.item, c.type, status});
  }
  business.decisions.swap(decisions); return state;
}
void add_candidate(BusinessState& business, const uint8_t* bytes, uint32_t size, uint32_t role) {
  auto command = read_command(bytes, size, role); authorize_command(business.policy, command);
  const auto id = event_id(command.order);
  const auto identity = business.identities.find(id);
  if (identity != business.identities.end()) {
    const auto& old = business.history.at(identity->second);
    if (old.command.role != role || old.bytes.size() != size || !std::equal(old.bytes.begin(), old.bytes.end(), bytes)) throw InvalidInput{};
    return;
  }
  if (business.history.size() >= MAX_POLICY_EVENTS || size > MAX_BYTES - business.byte_count) throw InvalidInput{};
  const auto order = command.order;
  business.history.emplace(order, Candidate{std::move(command), std::vector<uint8_t>(bytes, bytes + size)});
  business.identities.emplace(id, order); business.byte_count += size;
}
void configure_business(Session& session, const uint8_t* bytes, uint32_t size) {
  if (!session.items.empty() || session.business) throw InvalidInput{};
  auto business = std::make_shared<BusinessState>(); business->policy = read_policies(bytes, size); session.business = std::move(business);
}
void apply_authorized(Session& session, const uint8_t* bytes, uint32_t size, uint32_t role) {
  if (!session.business) { if (role < 1 || role > 3) throw InvalidInput{}; apply_session(session, bytes, size); return; }
  auto next = std::make_shared<BusinessState>(*session.business);
  if (role) add_candidate(*next, bytes, size, role);
  else {
    Reader r{bytes, size}; if (r.u32() != 0x32424353 || r.u32() != 2) throw InvalidInput{}; // SCB2 authenticated role/block pairs.
    const auto count = r.u32(); if (r.u32() != size || count > MAX_POLICY_EVENTS) throw InvalidInput{};
    for (uint32_t i = 0; i < count; ++i) { const auto proof_role = r.u32(), n = r.u32(); add_candidate(*next, r.take(n), n, proof_role); }
    if (r.offset != r.size) throw InvalidInput{};
  }
  auto state = replay_business(*next); session.items.swap(state); session.business.swap(next);
}
void snapshot_business(const Session& session) {
  snapshot_session(session);
  if (!session.business) return;
  output[4] = 2; append32(uint32_t(session.business->decisions.size()));
  for (const auto& decision : session.business->decisions) { append_text(decision.id); append_text(decision.item); append32(decision.type); append32(decision.status); }
  output_size();
}
void checkpoint_business(const Session& session) {
  if (!session.business) { checkpoint_session(session); return; }
  const auto& b = *session.business;
  append32(0x324b4353); append32(2); append32(uint32_t(b.history.size())); append32(0);
  append32(uint32_t(b.policy.bytes.size())); output.insert(output.end(), b.policy.bytes.begin(), b.policy.bytes.end());
  for (const auto& [order, candidate] : b.history) {
    append32(candidate.command.role); append32(uint32_t(candidate.bytes.size())); output.insert(output.end(), candidate.bytes.begin(), candidate.bytes.end());
    if (output.size() > MAX_BYTES) throw InvalidInput{};
  }
  output_size();
}
void restore_business(Session& session, const uint8_t* bytes, uint32_t size) {
  if (!session.business) { auto state = restore_session(bytes, size); session.items.swap(state); return; }
  Reader r{bytes, size}; if (r.u32() != 0x324b4353 || r.u32() != 2) throw InvalidInput{};
  const auto count = r.u32(); if (r.u32() != size || count > MAX_POLICY_EVENTS) throw InvalidInput{};
  const auto ps = r.u32(); const auto policy_bytes = r.take(ps);
  if (session.business->policy.bytes.size() != ps || !std::equal(session.business->policy.bytes.begin(), session.business->policy.bytes.end(), policy_bytes)) throw InvalidInput{};
  auto next = std::make_shared<BusinessState>(); next->policy = read_policies(policy_bytes, ps);
  for (uint32_t i = 0; i < count; ++i) { const auto role = r.u32(), n = r.u32(); add_candidate(*next, r.take(n), n, role); }
  if (r.offset != r.size || next->history.size() != count) throw InvalidInput{};
  auto state = replay_business(*next); session.items.swap(state); session.business.swap(next);
}
template<class F> uint32_t with_authorized_session(uint32_t handle, F fn) {
  clear_output(); const auto s = sessions.find(handle); if (s == sessions.end()) return 1;
  try { fn(*s->second); return 0; }
  catch (const PolicyDenied&) { clear_output(); return 3; }
  catch (const std::bad_alloc&) { clear_output(); return 2; }
  catch (...) { clear_output(); return 1; }
}
