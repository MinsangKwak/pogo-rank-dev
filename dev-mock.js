// ─────────────────────────────────────────────────────────────────────────────
// dev-mock.js — 로컬 테스트용 Firebase 목(mock). 2026-09-05 v2.7.1
//
// 왜 있나
//   로컬(localhost)에서는 Google 로그인 팝업이 자주 막힌다(앱 내장 브라우저·인증 도메인 등).
//   즐겨찾기 페이지(#/favs)·역할 보정·관리자 패널처럼 "로그인 뒤에만 보이는 화면"을
//   빌드 확인할 수 있게, 실제 Firebase SDK 대신 같은 모양의 가짜를 window.firebase에 심는다.
//
// 언제 로드되나 (components/auth.js initAuth)
//   hostname이 localhost/127.0.0.1 이고 주소에 ?mock 이 있을 때만. 배포(github.io)에서는 절대 로드되지 않는다.
//   이 파일은 frontend/static/ 에 있어 dist/ 로 그대로 복사될 뿐, index.html 번들에는 포함되지 않는다.
//
// 사용법
//   http://localhost:5503/?mock=1           관리자(ADMIN_UID)로 로그인된 상태 — 모든 기능
//   http://localhost:5503/?mock=friend      승인된 일반 친구 — 관리자 패널 없음
//   http://localhost:5503/?mock=pending     승인 대기 상태 — 즐겨찾기 저장 불가 안내 확인
//   해시 라우트(#/favs 등)는 ?mock 뒤에 그대로 붙이면 된다: /?mock=1#/favs
//
// 흉내 내는 범위 — auth.js·trainers.js가 실제로 부르는 것만
//   firebase.apps · initializeApp · auth() { onAuthStateChanged, getRedirectResult, signInWithPopup,
//   signInWithRedirect, signOut } · auth.GoogleAuthProvider · firestore() { collection().doc().get/set/delete,
//   collection().get() } · firestore.FieldValue { serverTimestamp, arrayUnion, arrayRemove }
//   데이터는 localStorage(pogo_mock_db)에 남아 새로 고쳐도 유지된다. 지우려면 ?mock=reset 으로 한 번 열면 된다.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mock') || '1';
  const DB_KEY = 'pogo_mock_db';
  const OUT_KEY = 'pogo_mock_signed_out';

  // ── 가짜 사용자 ────────────────────────────────────────────────────────────
  const adminUid = typeof ADMIN_UID !== 'undefined' && ADMIN_UID ? ADMIN_UID : 'mock-admin';
  const USERS = {
    '1':       { uid: adminUid,      email: 'admin@mock.local',   displayName: '로컬 테스트 (관리자)', photoURL: '' },
    'friend':  { uid: 'mock-friend', email: 'friend@mock.local',  displayName: '로컬 테스트 (친구)',   photoURL: '' },
    'pending': { uid: 'mock-pending', email: 'pending@mock.local', displayName: '로컬 테스트 (대기)',  photoURL: '' },
  };
  const mockUser = USERS[mode] || USERS['1'];

  // ── 가짜 Firestore: { 컬렉션: { 문서id: 데이터 } } 를 localStorage에 통째로 ──
  let store;
  try { store = mode === 'reset' ? null : JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch { store = null; }
  if (!store) {
    // 첫 실행 시드: 빈 즐겨찾기면 페이지가 텅 비어 확인이 안 되므로 PvE·PvP·기타가 섞인 종을 미리 넣어 둔다
    store = {
      allowlist: { 'friend@mock.local': { approved: true, name: '로컬 테스트 (친구)', at: new Date().toISOString() } },
      requests: {},
      users: {
        [adminUid]:    { email: 'admin@mock.local',  name: '로컬 테스트 (관리자)', favs: [150, 384, 383, 149, 68, 143, 302, 227, 25], roles: {} },
        'mock-friend': { email: 'friend@mock.local', name: '로컬 테스트 (친구)',   favs: [150, 6, 302], roles: {} },
      },
      trainers: { '테스트 트레이너': { name: '테스트 트레이너', code: '000000000000', order: 0 } },
    };
    try { localStorage.removeItem(OUT_KEY); } catch {}
  }
  const save = () => { try { localStorage.setItem(DB_KEY, JSON.stringify(store)); } catch {} };
  save();

  // FieldValue 센티널 — set() 시점에 실제 값으로 풀어 준다
  const SENTINEL = Symbol('fieldValue');
  const FieldValue = {
    serverTimestamp: () => ({ [SENTINEL]: 'ts' }),
    arrayUnion: (...values) => ({ [SENTINEL]: 'union', values }),
    arrayRemove: (...values) => ({ [SENTINEL]: 'remove', values }),
  };
  function resolveField(previous, incoming) {
    if (!incoming || typeof incoming !== 'object' || !(SENTINEL in incoming)) return incoming;
    const current = Array.isArray(previous) ? previous : [];
    if (incoming[SENTINEL] === 'ts') return new Date().toISOString();
    if (incoming[SENTINEL] === 'union') return [...new Set([...current, ...incoming.values])];
    if (incoming[SENTINEL] === 'remove') return current.filter((item) => !incoming.values.includes(item));
    return incoming;
  }

  const collectionOf = (name) => (store[name] ||= {});
  function docRef(collectionName, id) {
    return {
      id,
      async get() {
        const data = collectionOf(collectionName)[id];
        return { id, exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
      },
      async set(data, options) {
        const collection = collectionOf(collectionName);
        const base = options?.merge && collection[id] ? { ...collection[id] } : {};
        for (const [key, value] of Object.entries(data)) base[key] = resolveField(base[key], value);
        collection[id] = base;
        save();
      },
      async update(data) { return this.set(data, { merge: true }); },
      async delete() { delete collectionOf(collectionName)[id]; save(); },
    };
  }
  const db = {
    collection: (name) => ({
      doc: (id) => docRef(name, id),
      async get() {
        const docs = Object.entries(collectionOf(name)).map(([id, data]) => ({ id, exists: true, data: () => structuredClone(data) }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    }),
  };

  // ── 가짜 Auth ──────────────────────────────────────────────────────────────
  let signedOut = false;
  try { signedOut = localStorage.getItem(OUT_KEY) === '1'; } catch {}
  let currentUser = signedOut ? null : mockUser;
  const listeners = [];
  const notify = () => listeners.forEach((callback) => { try { callback(currentUser); } catch {} });
  const auth = {
    get currentUser() { return currentUser; },
    onAuthStateChanged(callback) { listeners.push(callback); setTimeout(() => callback(currentUser), 0); return () => {}; },
    async getRedirectResult() { return { user: null }; },
    async signInWithPopup() { currentUser = mockUser; try { localStorage.removeItem(OUT_KEY); } catch {} notify(); return { user: mockUser }; },
    async signInWithRedirect() { return this.signInWithPopup(); },
    async signOut() { currentUser = null; try { localStorage.setItem(OUT_KEY, '1'); } catch {} notify(); },
  };
  const authFn = () => auth;
  authFn.GoogleAuthProvider = class { setCustomParameters() {} };

  const firestoreFn = () => db;
  firestoreFn.FieldValue = FieldValue;

  window.firebase = {
    apps: [],
    initializeApp() { this.apps.push({ name: 'mock' }); return this.apps[0]; },
    auth: authFn,
    firestore: firestoreFn,
    __mock: { mode, store, user: mockUser },
  };
  console.info(`[dev-mock] Firebase 목 활성 — mode=${mode}, user=${mockUser.email}`);
})();
