/// Every IceBase failure. `code` uses Firebase's codes where Firebase has one
/// ('permission-denied', 'not-found', 'auth/user-disabled' …); `reason` names the IceBase check
/// that failed ('schema', 'missing-index', 'config', 'mode').
class IceBaseException implements Exception {
  final String code;
  final String message;
  final String? reason;
  final Map<String, Object?> details;

  IceBaseException(this.code, this.message, {this.reason, this.details = const {}});

  @override
  String toString() => 'IceBaseException($code${reason != null ? ', $reason' : ''}): $message';
}
