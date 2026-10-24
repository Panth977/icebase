import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

void main() {
  late Emulator emu;
  late IceBaseApp app;
  late IceBaseAuth auth;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'auth', emulatorOrigin: emu.url);
    auth = IceBaseAuth.instanceFor(app);
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });
  tearDown(() => auth.signOut());

  test('email + password: create, sign in, wrong password, profile', () async {
    final states = <String?>[];
    final sub = auth.authStateChanges().listen((u) => states.add(u?.uid));
    final c = await auth.createUserWithEmailAndPassword(email: 'Ann@Example.com', password: 'secret1');
    expect(c.user.email, 'ann@example.com');
    expect(auth.currentUser?.uid, c.user.uid);
    await auth.signOut();
    expect(auth.currentUser, isNull);
    await expectLater(auth.signInWithEmailAndPassword(email: 'ann@example.com', password: 'nope!!'), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'auth/wrong-password')));
    await expectLater(auth.createUserWithEmailAndPassword(email: 'ann@example.com', password: 'secret1'), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'auth/email-already-in-use')));
    final s = await auth.signInWithEmailAndPassword(email: 'ann@example.com', password: 'secret1');
    expect(s.user.uid, c.user.uid);
    await s.user.updateDisplayName('Ann');
    expect(auth.currentUser!.displayName, 'Ann');
    final t = await s.user.getIdTokenResult(true);
    expect(t.claims['email'], 'ann@example.com');
    expect(t.signInProvider, 'password');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await sub.cancel();
    expect(states, [null, c.user.uid, null, c.user.uid]);
  });

  test('anonymous', () async {
    final c = await auth.signInAnonymously();
    expect(c.user.isAnonymous, isTrue);
    expect((await c.user.getIdTokenResult()).signInProvider, 'anonymous');
  });

  test('custom email code sign-in goes over your sender', () async {
    final p = await auth.customEmailAuth.start('bo@example.com');
    expect(p.mode, 'code');
    final m = await emu.lastTo('bo@example.com');
    await expectLater(auth.customEmailAuth.verifyCode('000000x'), throwsA(isA<IceBaseException>()));
    final c = await auth.customEmailAuth.verifyCode(m['code'] as String);
    expect(c.user.email, 'bo@example.com');
    expect(auth.currentUser?.uid, c.user.uid);
  });

  test('signInWithPhoneNumber uses custom phone auth', () async {
    final r = await auth.signInWithPhoneNumber('+15550001111');
    final m = await emu.lastTo('+15550001111');
    final c = await r.confirm(m['code'] as String);
    expect(c.user.phoneNumber, '+15550001111');
  });

  test('custom password reset', () async {
    await auth.createUserWithEmailAndPassword(email: 'cy@example.com', password: 'first1');
    await auth.signOut();
    await auth.sendPasswordResetEmail(email: 'cy@example.com');
    final link = Uri.parse((await emu.lastTo('cy@example.com'))['link'] as String);
    final code = link.queryParameters['oobCode']!;
    expect(await auth.verifyPasswordResetCode(code), 'cy@example.com');
    await auth.confirmPasswordReset(code: code, newPassword: 'second2');
    final c = await auth.signInWithEmailAndPassword(email: 'cy@example.com', password: 'second2');
    expect(c.user.email, 'cy@example.com');
  });

  test('the ID token reaches the other services', () async {
    final f = IceBaseFunctions.instanceFor(app);
    expect((await f.httpsCallable('add').call<Map<String, Object?>>({'a': 1, 'b': 2})).data['uid'], isNull);
    final c = await auth.signInAnonymously();
    expect((await f.httpsCallable('add').call<Map<String, Object?>>({'a': 1, 'b': 2})).data, {'sum': 3, 'uid': c.user.uid});
  });

  test('delete the user', () async {
    final c = await auth.createUserWithEmailAndPassword(email: 'dee@example.com', password: 'secret1');
    await c.user.delete();
    expect(auth.currentUser, isNull);
    await expectLater(auth.signInWithEmailAndPassword(email: 'dee@example.com', password: 'secret1'), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'auth/user-not-found')));
  });
}
