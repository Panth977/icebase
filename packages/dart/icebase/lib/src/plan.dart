// The index rule (IDX-2), the same as the TypeScript SDK's: every index a query uses is
// declared — single-field ones too — and a query whose index is not declared is refused
// before it leaves, in every mode. Fields are key paths; strings are never split on dots.

import 'dart:convert';

import 'errors.dart';
import 'schema.dart';

sealed class FilterNode {
  Map<String, Object?> toJson(Object? Function(Object?) encode);
}

class FieldFilter extends FilterNode {
  final List<String> field;
  final String op;
  final Object? value;
  FieldFilter(this.field, this.op, this.value);
  @override
  Map<String, Object?> toJson(Object? Function(Object?) encode) => {'kind': 'field', 'field': field, 'op': op, 'value': encode(value)};
}

class CompositeFilter extends FilterNode {
  /// and | or
  final String kind;
  final List<FilterNode> filters;
  CompositeFilter(this.kind, this.filters);
  @override
  Map<String, Object?> toJson(Object? Function(Object?) encode) => {
        'kind': kind,
        'filters': [for (final f in filters) f.toJson(encode)]
      };
}

class OrderSpec {
  final List<String> field;
  final bool descending;
  const OrderSpec(this.field, {this.descending = false});
  String get dir => descending ? 'desc' : 'asc';
}

class Cursor {
  final List<Object?> values;
  final bool inclusive;

  /// A snapshot cursor: the document's data and path (values are derived in query order).
  final ({String path, Map<String, Object?> data})? snapshot;
  const Cursor(this.values, this.inclusive, {this.snapshot});
}

class QuerySpec {
  /// The concrete collection path, or null for a collection-group query.
  final String? path;
  final String collectionId;
  final List<FilterNode> filters;
  final List<OrderSpec> orders;
  final ({int n, bool last})? limit;
  final Cursor? start;
  final Cursor? end;
  const QuerySpec({required this.path, required this.collectionId, this.filters = const [], this.orders = const [], this.limit, this.start, this.end});

  QuerySpec copyWith({List<FilterNode>? filters, List<OrderSpec>? orders, ({int n, bool last})? limit, Cursor? start, Cursor? end}) => QuerySpec(
        path: path,
        collectionId: collectionId,
        filters: filters ?? this.filters,
        orders: orders ?? this.orders,
        limit: limit ?? this.limit,
        start: start ?? this.start,
        end: end ?? this.end,
      );
}

bool isName(List<String> p) => p.length == 1 && p[0] == '__name__';
String _key(List<String> p) => jsonEncode(p);
const _eq = {'==', 'in'};
const _contains = {'array-contains', 'array-contains-any'};

/// and()/or() flattened to disjunctive normal form.
List<List<FieldFilter>> dnf(List<FilterNode> filters) {
  List<List<FieldFilter>> of(FilterNode n) {
    if (n is FieldFilter) {
      return [
        [n]
      ];
    }
    final c = n as CompositeFilter;
    if (c.kind == 'or') return [for (final f in c.filters) ...of(f)];
    return c.filters.fold<List<List<FieldFilter>>>(
        [[]],
        (acc, child) => [
              for (final a in acc)
                for (final b in of(child)) [...a, ...b]
            ]);
  }

  return of(CompositeFilter('and', filters));
}

/// The full order: explicit orders, implicit inequality orders, then __name__.
List<OrderSpec> fullOrder(QuerySpec spec) {
  final orders = [...spec.orders];
  final ineq = <String, List<String>>{};
  for (final conj in dnf(spec.filters)) {
    for (final f in conj) {
      if (!_eq.contains(f.op) && !_contains.contains(f.op) && !isName(f.field)) ineq[_key(f.field)] = f.field;
    }
  }
  for (final k in ineq.keys.toList()..sort()) {
    if (!orders.any((o) => _key(o.field) == k)) orders.add(OrderSpec(ineq[k]!));
  }
  if (!orders.any((o) => isName(o.field))) orders.add(OrderSpec(const ['__name__'], descending: orders.isNotEmpty && orders.last.descending));
  return orders;
}

String _code(List<String> p) => p.length == 1 ? "'${p[0]}'" : "[${p.map((s) => "'$s'").join(', ')}]";

/// Null when the query is served by declared indexes, else the index(…) to declare.
({List<List<String>> fields, String suggestion})? missingIndex(CollectionDef c, QuerySpec spec) {
  bool single(IndexDef ix) => ix.fields.length == 1;
  bool hasSingle(List<String> p) => c.indexes.any((ix) => single(ix) && _key(ix.fields[0].path) == _key(p));
  for (final conj in dnf(spec.filters)) {
    final eq = <String, List<String>>{};
    List<String>? contains;
    final ineq = <String, List<String>>{};
    for (final f in conj) {
      if (isName(f.field)) continue;
      if (_eq.contains(f.op)) {
        eq[_key(f.field)] = f.field;
      } else if (_contains.contains(f.op)) {
        contains = f.field;
      } else {
        ineq[_key(f.field)] = f.field;
      }
    }
    final ordered = [...spec.orders.where((o) => !isName(o.field))];
    for (final k in ineq.keys.toList()..sort()) {
      if (!ordered.any((o) => _key(o.field) == k)) ordered.add(OrderSpec(ineq[k]!));
    }
    final sorted = ordered.where((o) => !eq.containsKey(_key(o.field))).toList();
    final all = <String, List<String>>{...eq, if (contains != null) _key(contains): contains, for (final o in sorted) _key(o.field): o.field};
    if (all.isEmpty) continue;
    final fields = all.values.toList();
    if (fields.length == 1) {
      if (hasSingle(fields[0])) continue;
      return (fields: fields, suggestion: 'index(${_code(fields[0])})');
    }
    bool serves(IndexDef ix) {
      if (ix.fields.length != fields.length) return false;
      final want = fields.map(_key).toSet();
      if (!ix.fields.every((f) => want.contains(_key(f.path)))) return false;
      final ce = ix.fields.where((f) => f.mode == 'contains').map((f) => _key(f.path)).firstOrNull;
      if (ce != (contains == null ? null : _key(contains))) return false;
      final tail = ix.fields.sublist(ix.fields.length - sorted.length);
      if (tail.any((t) => t.mode == 'contains')) return false;
      for (var i = 0; i < tail.length; i++) {
        if (_key(tail[i].path) != _key(sorted[i].field)) return false;
      }
      final same = [for (var i = 0; i < tail.length; i++) tail[i].mode == sorted[i].dir].every((x) => x);
      final reversed = [for (var i = 0; i < tail.length; i++) tail[i].mode != sorted[i].dir].every((x) => x);
      return same || reversed;
    }

    if (c.indexes.any((ix) => !single(ix) && serves(ix))) continue;
    if (sorted.isEmpty) {
      final lacking = fields.where((p) => !hasSingle(p)).toList();
      if (lacking.isEmpty) continue;
      return (fields: lacking, suggestion: lacking.map((p) => 'index(${_code(p)})').join(', '));
    }
    final parts = [...eq.values.map(_code), if (contains != null) 'contains(${_code(contains)})', for (final o in sorted) o.descending ? 'desc(${_code(o.field)})' : _code(o.field)];
    return (fields: fields, suggestion: 'index(${parts.join(', ')})');
  }
  return null;
}

/// Throw the IDX-2 error when a query needs an index that is not declared.
void assertIndexed(CollectionDef c, QuerySpec spec) {
  if (spec.path == null && !c.group) {
    throw IceBaseException('failed-precondition', "collectionGroup('${c.id}') needs group: true on collection('${c.path}') in the schema.", reason: 'missing-index');
  }
  final m = missingIndex(c, spec);
  if (m == null) return;
  throw IceBaseException(
    'failed-precondition',
    "The query on '${c.path}' needs an index on ${m.fields.map(showPath).join(' + ')} that is not declared.\nAdd ${m.suggestion} to the indexes of collection('${c.path}') in your schema.",
    reason: 'missing-index',
    details: {'index': m.suggestion},
  );
}
