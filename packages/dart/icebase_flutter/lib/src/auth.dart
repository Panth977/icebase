// firebase mode: Auth over firebase_auth. Custom auth (your senders) is routed by IceBaseAuth
// itself and ends in signInWithCustomToken here, so the session is a normal Firebase one.

import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart' as fa;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:icebase/icebase.dart';

IceBaseException _err(Object e) {
  if (e is fa.FirebaseAuthException) return IceBaseException('auth/${e.code}', e.message ?? e.code);
  if (e is IceBaseException) return e;
  return IceBaseException('auth/internal-error', '$e');
}

Future<T> _guard<T>(Future<T> Function() f) async {
  try {
    return await f();
  } catch (e) {
    throw _err(e);
  }
}

fa.ActionCodeSettings? _settings(ActionCodeSettings? s) => s == null ? null : fa.ActionCodeSettings(url: s.url, handleCodeInApp: s.handleCodeInApp);

class FlutterAuth extends IceBaseAuth {
  final fa.FirebaseAuth native;
  FlutterAuth(super.app, this.native);

  final _users = Expando<_User>();
  User? _wrap(fa.User? u) => u == null ? null : (_users[u] ??= _User(u));
  Future<UserCredential> _cred(Future<fa.UserCredential> Function() f) => _guard(() async {
        final c = await f();
        return UserCredential(_wrap(c.user)!, isNewUser: c.additionalUserInfo?.isNewUser ?? false);
      });

  @override
  User? get currentUser => _wrap(native.currentUser);
  @override
  Stream<User?> authStateChanges() => native.authStateChanges().map(_wrap);
  @override
  Stream<User?> idTokenChanges() => native.idTokenChanges().map(_wrap);
  @override
  Future<void> signOut() => _guard(native.signOut);

  @override
  Future<UserCredential> createUserWithEmailAndPassword({required String email, required String password}) => _cred(() => native.createUserWithEmailAndPassword(email: email, password: password));
  @override
  Future<UserCredential> signInWithEmailAndPassword({required String email, required String password}) => _cred(() => native.signInWithEmailAndPassword(email: email, password: password));
  @override
  Future<UserCredential> signInAnonymously() => _cred(native.signInAnonymously);
  @override
  Future<UserCredential> signInWithCustomToken(String token) => _cred(() => native.signInWithCustomToken(token));

  @override
  Future<void> nativeSendPasswordResetEmail(String email, ActionCodeSettings? settings) => _guard(() => native.sendPasswordResetEmail(email: email, actionCodeSettings: _settings(settings)));
  @override
  Future<String> nativeVerifyPasswordResetCode(String code) => _guard(() => native.verifyPasswordResetCode(code));
  @override
  Future<void> nativeConfirmPasswordReset(String code, String newPassword) => _guard(() => native.confirmPasswordReset(code: code, newPassword: newPassword));
  @override
  Future<void> nativeSendSignInLinkToEmail(String email, ActionCodeSettings settings) => _guard(() => native.sendSignInLinkToEmail(email: email, actionCodeSettings: _settings(settings)!));
  @override
  bool nativeIsSignInWithEmailLink(String link) => native.isSignInWithEmailLink(link);
  @override
  Future<UserCredential> nativeSignInWithEmailLink(String email, String link) => _cred(() => native.signInWithEmailLink(email: email, emailLink: link));
  @override
  Future<void> nativeApplyActionCode(String code) => _guard(() => native.applyActionCode(code));

  /// Firebase phone auth: signInWithPhoneNumber on the web, verifyPhoneNumber on mobile.
  @override
  Future<ConfirmationResult> nativeSignInWithPhoneNumber(String phoneNumber) async {
    if (kIsWeb) {
      final r = await _guard(() => native.signInWithPhoneNumber(phoneNumber));
      return ConfirmationResult(r.verificationId, (code) => _cred(() => r.confirm(code)));
    }
    final sent = Completer<String>();
    await _guard(() => native.verifyPhoneNumber(
          phoneNumber: phoneNumber,
          verificationCompleted: (_) {},
          verificationFailed: (e) {
            if (!sent.isCompleted) sent.completeError(_err(e));
          },
          codeSent: (id, _) {
            if (!sent.isCompleted) sent.complete(id);
          },
          codeAutoRetrievalTimeout: (_) {},
        ));
    final id = await sent.future;
    return ConfirmationResult(id, (code) => _cred(() => native.signInWithCredential(fa.PhoneAuthProvider.credential(verificationId: id, smsCode: code))));
  }
}

class _User implements User {
  final fa.User u;
  _User(this.u);

  @override
  String get uid => u.uid;
  @override
  String? get email => u.email;
  @override
  bool get emailVerified => u.emailVerified;
  @override
  String? get displayName => u.displayName;
  @override
  String? get photoURL => u.photoURL;
  @override
  String? get phoneNumber => u.phoneNumber;
  @override
  bool get isAnonymous => u.isAnonymous;
  @override
  List<UserInfo> get providerData => [for (final p in u.providerData) UserInfo(p.providerId, uid: p.uid, email: p.email, phoneNumber: p.phoneNumber)];

  @override
  Future<String> getIdToken([bool forceRefresh = false]) => _guard(() async => (await u.getIdToken(forceRefresh))!);
  @override
  Future<IdTokenResult> getIdTokenResult([bool forceRefresh = false]) => _guard(() async {
        final r = await u.getIdTokenResult(forceRefresh);
        return IdTokenResult(r.token!, (r.claims ?? const {}).cast<String, Object?>(), expirationTime: r.expirationTime, signInProvider: r.signInProvider);
      });
  @override
  Future<void> updateDisplayName(String? name) => _guard(() => u.updateDisplayName(name));
  @override
  Future<void> updatePhotoURL(String? url) => _guard(() => u.updatePhotoURL(url));
  @override
  Future<void> updatePassword(String newPassword) => _guard(() => u.updatePassword(newPassword));
  @override
  Future<void> sendEmailVerification([ActionCodeSettings? settings]) => _guard(() => u.sendEmailVerification(_settings(settings)));
  @override
  Future<void> reload() => _guard(u.reload);
  @override
  Future<void> delete() => _guard(u.delete);
}
