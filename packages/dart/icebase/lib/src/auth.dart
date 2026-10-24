// Auth with firebase_auth's names. When the config takes a sign-in method over
// (config.auth.custom), the standard calls go to IceBase's custom-auth endpoint — your senders,
// your templates — and end with signInWithCustomToken: the session is a normal one.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app.dart';
import 'emulator/auth.dart';
import 'errors.dart';

class UserInfo {
  final String providerId;
  final String? uid;
  final String? email;
  final String? phoneNumber;
  const UserInfo(this.providerId, {this.uid, this.email, this.phoneNumber});
}

/// The signed-in user (firebase_auth's User).
abstract class User {
  String get uid;
  String? get email;
  bool get emailVerified;
  String? get displayName;
  String? get photoURL;
  String? get phoneNumber;
  bool get isAnonymous;
  List<UserInfo> get providerData;

  Future<String> getIdToken([bool forceRefresh = false]);

  /// The token's claims, custom claims included.
  Future<IdTokenResult> getIdTokenResult([bool forceRefresh = false]);
  Future<void> updateDisplayName(String? name);
  Future<void> updatePhotoURL(String? url);
  Future<void> updatePassword(String newPassword);
  Future<void> sendEmailVerification([ActionCodeSettings? settings]);
  Future<void> reload();
  Future<void> delete();
}

class IdTokenResult {
  final String token;
  final Map<String, Object?> claims;
  final DateTime? expirationTime;
  final String? signInProvider;
  const IdTokenResult(this.token, this.claims, {this.expirationTime, this.signInProvider});
}

class UserCredential {
  final User user;
  final bool isNewUser;
  const UserCredential(this.user, {this.isNewUser = false});
}

class ActionCodeSettings {
  final String url;
  final bool handleCodeInApp;
  const ActionCodeSettings({required this.url, this.handleCodeInApp = true});
}

/// What signInWithPhoneNumber returns: confirm the code that was sent.
class ConfirmationResult {
  final String verificationId;
  final Future<UserCredential> Function(String code) _confirm;
  ConfirmationResult(this.verificationId, this._confirm);
  Future<UserCredential> confirm(String code) => _confirm(code);
}

/// Auth for one app. The emulator implementation ships here; firebase mode is icebase_flutter's.
abstract class IceBaseAuth {
  final IceBaseApp app;
  IceBaseAuth(this.app) {
    app.idToken = () async => currentUser?.getIdToken();
  }

  static IceBaseAuth instanceFor(IceBaseApp app) => app.driver<IceBaseAuth>('auth', () => EmulatorAuth(app));
  static IceBaseAuth get instance => instanceFor(IceBaseApp.instance());

  User? get currentUser;
  Stream<User?> authStateChanges();
  Stream<User?> idTokenChanges();
  Future<void> signOut();

  Future<UserCredential> createUserWithEmailAndPassword({required String email, required String password});
  Future<UserCredential> signInWithEmailAndPassword({required String email, required String password});
  Future<UserCredential> signInAnonymously();
  Future<UserCredential> signInWithCustomToken(String token);

  // The native (Firebase) versions of what custom auth may take over.
  Future<void> nativeSendPasswordResetEmail(String email, ActionCodeSettings? settings);
  Future<String> nativeVerifyPasswordResetCode(String code);
  Future<void> nativeConfirmPasswordReset(String code, String newPassword);
  Future<void> nativeSendSignInLinkToEmail(String email, ActionCodeSettings settings);
  bool nativeIsSignInWithEmailLink(String link);
  Future<UserCredential> nativeSignInWithEmailLink(String email, String link);
  Future<void> nativeApplyActionCode(String code);
  Future<ConfirmationResult> nativeSignInWithPhoneNumber(String phoneNumber);

  CustomAuthInfo? get _custom => app.config.customAuth;

  // ── the standard names, routed ────────────────────────────────────────────────

  Future<void> sendPasswordResetEmail({required String email, ActionCodeSettings? actionCodeSettings}) => _custom?.email == true
      ? custom.call('/reset/start', {'email': email, if (actionCodeSettings != null) 'continueUrl': actionCodeSettings.url})
      : nativeSendPasswordResetEmail(email, actionCodeSettings);

  Future<String> verifyPasswordResetCode(String code) async => _custom?.email == true ? (await custom.call('/reset/check', {'oobCode': code}))['email'] as String : nativeVerifyPasswordResetCode(code);

  Future<void> confirmPasswordReset({required String code, required String newPassword}) =>
      _custom?.email == true ? custom.call('/reset/confirm', {'oobCode': code, 'newPassword': newPassword}) : nativeConfirmPasswordReset(code, newPassword);

  Future<void> sendSignInLinkToEmail({required String email, required ActionCodeSettings actionCodeSettings}) =>
      _custom?.email == true ? customEmailAuth.start(email, continueUrl: actionCodeSettings.url) : nativeSendSignInLinkToEmail(email, actionCodeSettings);

  bool isSignInWithEmailLink(String emailLink) => _custom?.email == true ? (Uri.tryParse(emailLink)?.queryParameters.containsKey('icebase_link') ?? false) : nativeIsSignInWithEmailLink(emailLink);

  Future<UserCredential> signInWithEmailLink({required String email, required String emailLink}) async {
    if (_custom?.email != true) return nativeSignInWithEmailLink(email, emailLink);
    final t = Uri.parse(emailLink).queryParameters['icebase_link'];
    if (t == null) throw IceBaseException('auth/argument-error', 'Not an IceBase sign-in link');
    return signInWithCustomToken((await custom.call('/email/link', {'email': email, 'token': t}))['token'] as String);
  }

  Future<void> applyActionCode(String code) => _custom?.email == true ? custom.call('/verify/confirm', {'oobCode': code}) : nativeApplyActionCode(code);

  /// The code goes over your WhatsApp / SMS sender with custom phone auth (no reCAPTCHA).
  Future<ConfirmationResult> signInWithPhoneNumber(String phoneNumber) async {
    if (_custom?.phone != true) return nativeSignInWithPhoneNumber(phoneNumber);
    final id = (await custom.call('/phone/start', {'phoneNumber': phoneNumber}))['verificationId'] as String;
    return ConfirmationResult(id, (code) async => signInWithCustomToken((await custom.call('/phone/verify', {'verificationId': id, 'code': code}))['token'] as String));
  }

  /// @nodoc the custom-auth endpoint.
  late final CustomAuthClient custom = CustomAuthClient(this);

  /// Custom email sign-in step by step (approval / link / code).
  late final CustomEmailAuth customEmailAuth = CustomEmailAuth._(this);

  /// Google sign-in with your own OAuth client (config.auth.custom.google).
  late final CustomGoogleOAuth customGoogleOAuth = CustomGoogleOAuth._(this);
}

/// Google sign-in with your own OAuth client. Open [authorizationUrl] in a browser (on Flutter:
/// flutter_web_auth_2 or url_launcher); the endpoint sends the browser back to [returnUrl] with
/// `#icebase_token=…`; hand that URL to [completeFromRedirect].
class CustomGoogleOAuth {
  final IceBaseAuth _auth;
  CustomGoogleOAuth._(this._auth);

  Uri authorizationUrl(String returnUrl) {
    if (_auth.app.config.customAuth?.google != true) throw IceBaseException('auth/operation-not-allowed', 'config.auth.custom.google is not set');
    return Uri.parse('${_auth.custom.endpoint}/google/start').replace(queryParameters: {'mode': 'redirect', 'return': returnUrl});
  }

  Future<UserCredential> completeFromRedirect(Uri redirected) {
    final q = Uri.splitQueryString(redirected.fragment);
    final t = q['icebase_token'];
    if (t == null) throw IceBaseException(q['icebase_error'] ?? 'auth/argument-error', q['icebase_error'] == null ? 'No IceBase sign-in result in this URL' : 'Google sign-in failed');
    return _auth.signInWithCustomToken(t);
  }
}

/// Talks to the custom-auth endpoint (`icebaseAuth` function or the emulator's /__/icebase/auth).
class CustomAuthClient {
  final IceBaseAuth auth;
  final http.Client _http = http.Client();
  CustomAuthClient(this.auth);

  String get endpoint {
    final app = auth.app;
    final c = app.config.customAuth;
    if (c?.endpoint != null) return c!.endpoint!;
    if (app.modes['auth'] == 'emulator') return '${app.emulatorOrigin}/__/icebase/auth';
    return 'https://${app.config.functionsRegion}-${app.config.projectId}.cloudfunctions.net/icebaseAuth';
  }

  Future<Map<String, Object?>> call(String route, Map<String, Object?> body) async {
    final http.Response res;
    try {
      res = await _http.post(Uri.parse('$endpoint$route'), headers: {'content-type': 'application/json'}, body: jsonEncode(body));
    } catch (e) {
      throw IceBaseException('auth/network-request-failed', 'Could not reach the IceBase auth endpoint: $e');
    }
    final j = (jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map).cast<String, Object?>();
    final err = j['error'];
    if (res.statusCode >= 400 || err != null) {
      final e = (err as Map?)?.cast<String, Object?>() ?? const {};
      throw IceBaseException((e['code'] ?? 'auth/internal-error').toString(), (e['message'] ?? 'IceBase auth ${res.statusCode}').toString(),
          details: {if (e['retryAfter'] != null) 'retryAfter': e['retryAfter']});
    }
    return j;
  }
}

/// A sign-in started in this session and not finished yet.
class PendingEmail {
  /// approval | link | code
  final String mode;
  final String email;
  final String? signinId;
  final String? clientSecret;
  final DateTime expiresAt;
  const PendingEmail(this.mode, this.email, this.expiresAt, {this.signinId, this.clientSecret});
}

class CustomEmailAuth {
  final IceBaseAuth _auth;
  PendingEmail? _pending;
  CustomEmailAuth._(this._auth);

  PendingEmail? get pending => _pending != null && _pending!.expiresAt.isAfter(DateTime.now()) ? _pending : null;

  /// Send the approval mail, sign-in link or code.
  Future<PendingEmail> start(String email, {String? continueUrl}) async {
    final r = await _auth.custom.call('/email/start', {'email': email, if (continueUrl != null) 'continueUrl': continueUrl});
    final p =
        PendingEmail(r['mode'] as String, email, DateTime.fromMillisecondsSinceEpoch((r['expiresAt'] as num).toInt()), signinId: r['signinId'] as String?, clientSecret: r['clientSecret'] as String?);
    _pending = p.mode == 'link' ? null : p;
    return p;
  }

  /// Code mode: sign in with the emailed code.
  Future<UserCredential> verifyCode(String code) async {
    final p = pending;
    if (p?.signinId == null) throw IceBaseException('auth/argument-error', 'No pending email sign-in: call start() first');
    final r = await _auth.custom.call('/email/code', {'signinId': p!.signinId, 'code': code});
    _pending = null;
    return _auth.signInWithCustomToken(r['token'] as String);
  }

  /// Approval mode: resolves signed in once the email's button is pressed.
  Future<UserCredential> waitForApproval({void Function(String state)? onState, Duration poll = const Duration(seconds: 2)}) async {
    final p = pending;
    if (p == null || p.mode != 'approval') throw IceBaseException('auth/argument-error', 'No pending email approval: call start() first');
    onState?.call('pending');
    for (;;) {
      final r = await _auth.custom.call('/email/collect', {'signinId': p.signinId, 'clientSecret': p.clientSecret});
      final state = r['state'] as String;
      if (state == 'approved' && r['token'] != null) {
        _pending = null;
        onState?.call('approved');
        return _auth.signInWithCustomToken(r['token'] as String);
      }
      if (state == 'revoked' || state == 'expired') {
        _pending = null;
        onState?.call(state);
        throw IceBaseException(state == 'revoked' ? 'auth/user-cancelled' : 'auth/expired-action-code', state == 'revoked' ? 'The sign-in was turned down from the email.' : 'The email link expired.');
      }
      if (DateTime.now().isAfter(p.expiresAt)) throw IceBaseException('auth/expired-action-code', 'The email link expired.');
      await Future<void>.delayed(poll);
    }
  }

  Future<void> cancel() async {
    final p = _pending;
    _pending = null;
    if (p?.signinId != null) await _auth.custom.call('/email/cancel', {'signinId': p!.signinId, 'clientSecret': p.clientSecret}).catchError((_) => <String, Object?>{});
  }
}
