// emulator mode: Auth on the IceBase server, over the Identity Toolkit / securetoken REST APIs it
// speaks (the same ones the Firebase SDKs use against the Firebase emulator). The session lives
// in memory.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../app.dart';
import '../auth.dart';
import '../errors.dart';
import 'transport.dart';

/// Identity Toolkit error messages → firebase_auth codes.
const _codes = {
  'EMAIL_EXISTS': 'email-already-in-use',
  'EMAIL_NOT_FOUND': 'user-not-found',
  'INVALID_PASSWORD': 'wrong-password',
  'INVALID_LOGIN_CREDENTIALS': 'invalid-credential',
  'WEAK_PASSWORD': 'weak-password',
  'INVALID_EMAIL': 'invalid-email',
  'USER_DISABLED': 'user-disabled',
  'USER_NOT_FOUND': 'user-not-found',
  'INVALID_OOB_CODE': 'invalid-action-code',
  'EXPIRED_OOB_CODE': 'expired-action-code',
  'INVALID_CODE': 'invalid-verification-code',
  'INVALID_SESSION_INFO': 'invalid-verification-id',
  'INVALID_PHONE_NUMBER': 'invalid-phone-number',
  'INVALID_ID_TOKEN': 'invalid-user-token',
  'TOKEN_EXPIRED': 'user-token-expired',
  'INVALID_REFRESH_TOKEN': 'invalid-user-token',
  'INVALID_CUSTOM_TOKEN': 'invalid-custom-token',
  'PHONE_NUMBER_EXISTS': 'phone-number-already-exists',
};

Map<String, Object?> _claims(String jwt) {
  final parts = jwt.split('.');
  if (parts.length < 2) return const {};
  return (jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))) as Map).cast<String, Object?>();
}

class EmulatorAuth extends IceBaseAuth {
  final Transport _t;
  _User? _user;
  final _authState = StreamController<User?>.broadcast();
  final _tokenState = StreamController<User?>.broadcast();

  EmulatorAuth(IceBaseApp app)
      : _t = Transport.of(app),
        super(app) {
    app.onDelete(() async {
      await _authState.close();
      await _tokenState.close();
    });
  }

  String get _itk => '${app.emulatorOrigin}/identitytoolkit.googleapis.com/v1';

  Future<Map<String, Object?>> rest(String method, Map<String, Object?> body) async {
    final http.Response res;
    try {
      res = await _t.client.post(Uri.parse('$_itk/accounts:$method?key=fake-api-key'), headers: {'content-type': 'application/json'}, body: jsonEncode(body));
    } catch (e) {
      throw IceBaseException('auth/network-request-failed', 'cannot reach the IceBase emulator at ${app.emulatorOrigin}: $e');
    }
    return _decode(res);
  }

  Map<String, Object?> _decode(http.Response res) {
    final j = (jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map).cast<String, Object?>();
    if (res.statusCode >= 400 || j['error'] != null) {
      final msg = ((j['error'] as Map?)?['message'] ?? 'auth ${res.statusCode}').toString();
      final key = msg.split(' : ').first.trim();
      throw IceBaseException('auth/${_codes[key] ?? key.toLowerCase().replaceAll('_', '-')}', msg);
    }
    return j;
  }

  Future<UserCredential> _signedIn(Map<String, Object?> r) async {
    final u = _User(this, r['idToken'] as String, r['refreshToken'] as String);
    await u.reload();
    final changed = _user?.uid != u.uid;
    _user = u;
    if (changed) _authState.add(u);
    _tokenState.add(u);
    return UserCredential(u, isNewUser: r['isNewUser'] == true);
  }

  @override
  User? get currentUser => _user;

  @override
  Stream<User?> authStateChanges() async* {
    yield _user;
    yield* _authState.stream;
  }

  @override
  Stream<User?> idTokenChanges() async* {
    yield _user;
    yield* _tokenState.stream;
  }

  @override
  Future<void> signOut() async {
    if (_user == null) return;
    _user = null;
    _authState.add(null);
    _tokenState.add(null);
  }

  @override
  Future<UserCredential> createUserWithEmailAndPassword({required String email, required String password}) async =>
      _signedIn(await rest('signUp', {'email': email, 'password': password, 'returnSecureToken': true}));

  @override
  Future<UserCredential> signInWithEmailAndPassword({required String email, required String password}) async =>
      _signedIn(await rest('signInWithPassword', {'email': email, 'password': password, 'returnSecureToken': true}));

  @override
  Future<UserCredential> signInAnonymously() async => _signedIn(await rest('signUp', {'returnSecureToken': true}));

  @override
  Future<UserCredential> signInWithCustomToken(String token) async => _signedIn(await rest('signInWithCustomToken', {'token': token, 'returnSecureToken': true}));

  @override
  Future<void> nativeSendPasswordResetEmail(String email, ActionCodeSettings? settings) =>
      rest('sendOobCode', {'requestType': 'PASSWORD_RESET', 'email': email, if (settings != null) 'continueUrl': settings.url});

  @override
  Future<String> nativeVerifyPasswordResetCode(String code) async => (await rest('resetPassword', {'oobCode': code}))['email'] as String;

  @override
  Future<void> nativeConfirmPasswordReset(String code, String newPassword) => rest('resetPassword', {'oobCode': code, 'newPassword': newPassword});

  @override
  Future<void> nativeSendSignInLinkToEmail(String email, ActionCodeSettings settings) => rest('sendOobCode', {'requestType': 'EMAIL_SIGNIN', 'email': email, 'continueUrl': settings.url});

  @override
  bool nativeIsSignInWithEmailLink(String link) {
    final q = Uri.tryParse(link)?.queryParameters ?? const {};
    return q['mode'] == 'signIn' && q.containsKey('oobCode');
  }

  @override
  Future<UserCredential> nativeSignInWithEmailLink(String email, String link) async {
    final code = Uri.parse(link).queryParameters['oobCode'];
    if (code == null) throw IceBaseException('auth/argument-error', 'Not a sign-in link');
    return _signedIn(await rest('signInWithEmailLink', {'email': email, 'oobCode': code, 'returnSecureToken': true}));
  }

  @override
  Future<void> nativeApplyActionCode(String code) => rest('update', {'oobCode': code});

  @override
  Future<ConfirmationResult> nativeSignInWithPhoneNumber(String phoneNumber) async {
    final s = (await rest('sendVerificationCode', {'phoneNumber': phoneNumber, 'recaptchaToken': 'emulator'}))['sessionInfo'] as String;
    return ConfirmationResult(s, (code) async => _signedIn(await rest('signInWithPhoneNumber', {'sessionInfo': s, 'code': code})));
  }

  Future<(String, String)> _refresh(String refreshToken) async {
    final http.Response res;
    try {
      res = await _t.client.post(Uri.parse('${app.emulatorOrigin}/securetoken.googleapis.com/v1/token?key=fake-api-key'),
          headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'grant_type=refresh_token&refresh_token=${Uri.encodeQueryComponent(refreshToken)}');
    } catch (e) {
      throw IceBaseException('auth/network-request-failed', 'cannot reach the IceBase emulator at ${app.emulatorOrigin}: $e');
    }
    final j = _decode(res);
    return (j['id_token'] as String, j['refresh_token'] as String);
  }

  void _tokenChanged(_User u) {
    if (identical(_user, u)) _tokenState.add(u);
  }

  void _gone(_User u) {
    if (identical(_user, u)) {
      _user = null;
      _authState.add(null);
      _tokenState.add(null);
    }
  }
}

class _User implements User {
  final EmulatorAuth _auth;
  String _idToken;
  String _refreshToken;
  Map<String, Object?> _info = const {};

  _User(this._auth, this._idToken, this._refreshToken);

  Map<String, Object?> get _c => _claims(_idToken);

  @override
  String get uid => _c['user_id'] as String;
  @override
  String? get email => _info['email'] as String?;
  @override
  bool get emailVerified => _info['emailVerified'] == true;
  @override
  String? get displayName => _info['displayName'] as String?;
  @override
  String? get photoURL => _info['photoUrl'] as String?;
  @override
  String? get phoneNumber => _info['phoneNumber'] as String?;
  @override
  bool get isAnonymous => _info['isAnonymous'] == true || ((_c['firebase'] as Map?)?['sign_in_provider'] == 'anonymous');
  @override
  List<UserInfo> get providerData => [
        for (final p in (_info['providerUserInfo'] as List? ?? const []))
          UserInfo((p as Map)['providerId'] as String, uid: p['rawId'] as String?, email: p['email'] as String?, phoneNumber: p['phoneNumber'] as String?),
      ];

  @override
  Future<String> getIdToken([bool forceRefresh = false]) async {
    final exp = (_c['exp'] as num).toInt() * 1000;
    if (forceRefresh || exp - DateTime.now().millisecondsSinceEpoch < 5 * 60 * 1000) {
      final (id, refresh) = await _auth._refresh(_refreshToken);
      _idToken = id;
      _refreshToken = refresh;
      _auth._tokenChanged(this);
    }
    return _idToken;
  }

  @override
  Future<IdTokenResult> getIdTokenResult([bool forceRefresh = false]) async {
    final t = await getIdToken(forceRefresh);
    final c = _claims(t);
    return IdTokenResult(t, c, expirationTime: DateTime.fromMillisecondsSinceEpoch((c['exp'] as num).toInt() * 1000), signInProvider: (c['firebase'] as Map?)?['sign_in_provider'] as String?);
  }

  Future<void> _update(Map<String, Object?> b) async {
    final r = await _auth.rest('update', {'idToken': await getIdToken(), ...b});
    if (r['idToken'] != null) {
      _idToken = r['idToken'] as String;
      _refreshToken = r['refreshToken'] as String;
      _auth._tokenChanged(this);
    }
    await reload();
  }

  @override
  Future<void> updateDisplayName(String? name) => _update(name == null
      ? {
          'deleteAttribute': ['DISPLAY_NAME']
        }
      : {'displayName': name});
  @override
  Future<void> updatePhotoURL(String? url) => _update(url == null
      ? {
          'deleteAttribute': ['PHOTO_URL']
        }
      : {'photoUrl': url});
  @override
  Future<void> updatePassword(String newPassword) => _update({'password': newPassword});

  @override
  Future<void> sendEmailVerification([ActionCodeSettings? settings]) async {
    if (_auth.app.config.customAuth?.email == true) {
      await _auth.custom.call('/verify/start', {'idToken': await getIdToken(), if (settings != null) 'continueUrl': settings.url});
      return;
    }
    await _auth.rest('sendOobCode', {'requestType': 'VERIFY_EMAIL', 'idToken': await getIdToken(), if (settings != null) 'continueUrl': settings.url});
  }

  @override
  Future<void> reload() async {
    final r = await _auth.rest('lookup', {'idToken': await getIdToken()});
    _info = ((r['users'] as List).first as Map).cast<String, Object?>();
  }

  @override
  Future<void> delete() async {
    await _auth.rest('delete', {'idToken': await getIdToken()});
    _auth._gone(this);
  }

  @override
  String toString() => 'User($uid)';
}
