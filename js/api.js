// Supabase 연결 + 함수(RPC) 호출 + 회원 로그인 도우미.
// config.js가 비어 있거나 주소 끝에 ?demo 를 붙이면 저장되지 않는 예시 데이터로 동작합니다.
(function () {
  'use strict';

  const cfg = window.HOOPS_CONFIG || {};
  const url = String(cfg.SUPABASE_URL || '').trim();
  const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
  const isDemo = !(url && key) || new URLSearchParams(location.search).has('demo');
  const client = !isDemo && window.supabase ? window.supabase.createClient(url, key) : null;

  const LIB_ERROR = 'Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.';

  async function callRpc(name, params) {
    if (isDemo) return mockRpc(name, params || {});
    if (!client) throw new Error(LIB_ERROR);
    const { data, error } = await client.rpc(name, params);
    if (error) throw new Error(toKoreanMessage(error));
    return data;
  }

  function toKoreanMessage(error) {
    // 함수가 없을 때: SQL을 아직 실행하지 않은 경우가 대부분
    if (error.code === 'PGRST202' || error.code === 'PGRST203') {
      return '서버 함수를 찾을 수 없습니다. Supabase SQL Editor에서 supabase 폴더의 SQL 파일(001~005)을 순서대로 모두 실행했는지 확인해 주세요.';
    }
    // 로그인하지 않은 채 회원 전용 함수를 부른 경우
    if (error.code === '42501') return '로그인이 필요합니다.';
    if (error.code === '23514') return '입력값이 조건에 맞지 않습니다. 글자 수와 숫자 범위를 확인해 주세요.';
    if (/fetch/i.test(error.message || '')) return '서버에 연결할 수 없습니다. 인터넷 연결과 js/config.js 값을 확인해 주세요.';
    // SQL 함수에서 raise exception 으로 보낸 한국어 메시지는 그대로 사용
    return error.message || '알 수 없는 오류가 발생했습니다.';
  }

  // ── 회원 (Supabase Auth) ───────────────────────────────────────
  const toUser = (u) => (u ? { email: u.email, nickname: (u.user_metadata?.nickname || '').trim() || '회원' } : null);

  function toKoreanAuthMessage(error) {
    const msg = error.message || '';
    const code = error.code || '';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 틀렸습니다.';
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return '이메일 인증이 아직 끝나지 않았습니다. 받은 메일의 링크를 눌러 주세요.';
    if (code === 'user_already_exists' || /already registered/i.test(msg)) return '이미 가입된 이메일입니다. 로그인해 주세요.';
    if (code === 'weak_password' || /password should be/i.test(msg)) return '비밀번호가 너무 짧거나 단순합니다. 6자 이상으로 정해 주세요.';
    if (code === 'email_address_invalid' || /invalid.*email|unable to validate email/i.test(msg)) return '이메일 주소 형식이 올바르지 않습니다.';
    if (code === 'signup_disabled') return '지금은 회원가입을 받지 않습니다.';
    if (/rate limit|too many/i.test(msg) || error.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    if (/fetch/i.test(msg)) return '서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.';
    return msg || '알 수 없는 오류가 발생했습니다.';
  }

  const realAuth = {
    async getUser() {
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return toUser(data.session?.user);
    },
    // 반환값 needsConfirm: true 이면 인증 메일의 링크를 눌러야 로그인됨
    async signUp(email, password, nickname) {
      if (!client) throw new Error(LIB_ERROR);
      const { data, error } = await client.auth.signUp({
        email, password,
        options: { data: { nickname }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw new Error(toKoreanAuthMessage(error));
      // 이미 가입된 이메일이면 오류 대신 identities 가 빈 가짜 사용자를 돌려줌
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error('이미 가입된 이메일입니다. 로그인해 주세요.');
      }
      return { needsConfirm: !data.session };
    },
    async signIn(email, password) {
      if (!client) throw new Error(LIB_ERROR);
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(toKoreanAuthMessage(error));
    },
    async signOut() {
      if (!client) return;
      const { error } = await client.auth.signOut();
      if (error) throw new Error(toKoreanAuthMessage(error));
    },
    onChange(callback) {
      if (!client) return;
      // 콜백 안에서 바로 Supabase를 다시 부르면 멈출 수 있어 한 박자 늦춰 실행
      client.auth.onAuthStateChange((_event, session) => setTimeout(() => callback(toUser(session?.user)), 0));
    },
  };

  // ── 예시 모드 (화면 확인용, 새로고침하면 사라짐) ──────────────────────
  const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  let seq = 100;
  const mock = {
    user: null,           // 지금 로그인한 예시 회원 { email, nickname }
    users: new Map(),     // email → { password, nickname }
    listeners: [],
    games: [
      { id: 1, game_type: '5v5', title: '토요일 저녁 5:5 풀코트, 4명 구합니다', gym_name: '마포구민체육센터', region: '서울 마포구',
        game_at: hoursFromNow(30), duration_min: 120, capacity: 10, reserved_count: 6, fee: 8000, level: '중수',
        description: '주차 2시간 무료, 샤워실 있습니다.\n조끼는 준비해 둘게요. 실내화 꼭 챙겨 주세요.',
        contact: 'https://open.kakao.com/o/example', host_nickname: '대관왕', is_closed: false,
        created_at: hoursFromNow(-5), owner: 'host1@example.com' },
      { id: 2, game_type: '5v5', title: '평일 퇴근 후 가볍게 뛰실 분', gym_name: '성남 종합운동장 실내체육관', region: '경기 성남시',
        game_at: hoursFromNow(52), duration_min: 90, capacity: 10, reserved_count: 7, fee: 5000, level: '초보',
        description: '초보 환영합니다. 승패보다 즐겁게 뛰는 분위기예요.', contact: '', host_nickname: '점프슛',
        is_closed: false, created_at: hoursFromNow(-20), owner: 'host2@example.com' },
      { id: 3, game_type: '5v5', title: '일요일 오전 3파전 (15명)', gym_name: '해운대 스포츠센터', region: '부산 해운대구',
        game_at: hoursFromNow(100), duration_min: 180, capacity: 15, reserved_count: 5, fee: 10000, level: '고수',
        description: '', contact: '', host_nickname: '센텀', is_closed: false, created_at: hoursFromNow(-2), owner: 'host3@example.com' },
      { id: 4, game_type: '3v3', title: '점심시간 반코트 3:3 두 분 구해요', gym_name: '한강공원 농구장', region: '서울 영등포구',
        game_at: hoursFromNow(20), duration_min: 60, capacity: 6, reserved_count: 3, fee: 0, level: '무관',
        description: '야외 코트라 비 오면 취소합니다.', contact: '', host_nickname: '하프코트', is_closed: false,
        created_at: hoursFromNow(-6), owner: 'host4@example.com' },
    ],
    participants: [
      { id: 11, game_id: 1, nickname: '3점슈터', pos: '가드', user: 'p1@example.com', created_at: hoursFromNow(-3) },
      { id: 12, game_id: 1, nickname: '리바운더', pos: '센터', user: 'p2@example.com', created_at: hoursFromNow(-2) },
      { id: 13, game_id: 2, nickname: '농린이', pos: '무관', user: 'p3@example.com', created_at: hoursFromNow(-9) },
      { id: 14, game_id: 2, nickname: '패스마스터', pos: '가드', user: 'p4@example.com', created_at: hoursFromNow(-8) },
      { id: 15, game_id: 2, nickname: '골밑', pos: '포워드', user: 'p5@example.com', created_at: hoursFromNow(-1) },
      { id: 16, game_id: 4, nickname: '스트릿볼', pos: '가드', user: 'p6@example.com', created_at: hoursFromNow(-4) },
    ],
  };
  const fail = (msg) => { throw new Error(msg); };
  const sideMax = (g) => (g.game_type === '3v3' ? 3 : 5);
  const sideOf = (p) => p.side || 'guest';
  const countSide = (id, side) => mock.participants.filter((p) => p.game_id === id && sideOf(p) === side).length;
  // 예시 글마다 주최측 명단 채우기: [글 번호, 주최측 인원]
  [[1, 4], [2, 5], [3, 2], [4, 2]].forEach(([gameId, n]) => {
    const g = mock.games.find((x) => x.id === gameId);
    for (let i = 0; i < n; i += 1) {
      mock.participants.push({ id: ++seq, game_id: gameId, side: 'host', pos: '무관', created_at: g.created_at,
        nickname: i === 0 ? g.host_nickname : g.host_nickname + ' 지인' + i, user: i === 0 ? g.owner : null });
    }
  });
  const needLogin = () => mock.user || fail('로그인이 필요합니다');
  const myGame = (id) => {
    const me = needLogin();
    return mock.games.find((g) => g.id === id && g.owner === me.email) || fail('내가 쓴 모집글만 관리할 수 있습니다');
  };
  const gameFields = (p) => ({
    game_type: ['5v5', '3v3'].includes(p.p_game_type) ? p.p_game_type : fail('게임 종류 값이 올바르지 않습니다'),
    title: p.p_title.trim(), gym_name: p.p_gym_name.trim(), region: (p.p_region || '').trim(),
    game_at: p.p_game_at, duration_min: p.p_duration_min, fee: p.p_fee, level: p.p_level,
    description: (p.p_description || '').trim(), contact: (p.p_contact || '').trim(),
  });

  const mockHandlers = {
    list_games: () => mock.games
      .map(({ owner, ...g }) => ({
        ...g, joined_count: countSide(g.id, 'host') + countSide(g.id, 'guest'),
        host_count: countSide(g.id, 'host'), guest_count: countSide(g.id, 'guest'), side_max: sideMax(g),
        is_mine: Boolean(mock.user && owner === mock.user.email),
        i_joined: Boolean(mock.user && mock.participants.some((x) => x.game_id === g.id && x.user === mock.user.email)),
      }))
      .sort((a, b) => new Date(a.game_at) - new Date(b.game_at)),
    list_participants: (p) => mock.participants
      .filter((x) => x.game_id === p.p_game_id)
      .map(({ user, game_id, ...rest }) => ({ ...rest, side: sideOf(rest), is_me: Boolean(mock.user && user === mock.user.email) })),
    create_game: (p) => {
      const me = needLogin();
      const g = { id: ++seq, ...gameFields(p), host_nickname: me.nickname, is_closed: false,
                  created_at: new Date().toISOString(), owner: me.email };
      mock.games.push(g);
      // 글쓴이는 주최측 첫 번째로 자동 등록
      mock.participants.push({ id: ++seq, game_id: g.id, side: 'host', nickname: me.nickname, pos: '무관', user: me.email, created_at: g.created_at });
      return g.id;
    },
    update_game: (p) => {
      const g = myGame(p.p_id);
      const fields = gameFields(p);
      const max = sideMax(fields);
      if (countSide(g.id, 'host') > max || countSide(g.id, 'guest') > max) {
        fail('한쪽 명단이 이미 ' + max + '명을 넘어 이 게임 종류로 바꿀 수 없습니다. 먼저 명단을 줄여 주세요');
      }
      Object.assign(g, fields);
    },
    delete_game: (p) => {
      const g = myGame(p.p_id);
      mock.games = mock.games.filter((x) => x !== g);
      mock.participants = mock.participants.filter((x) => x.game_id !== g.id);
    },
    set_game_closed: (p) => { myGame(p.p_id).is_closed = p.p_closed; },
    join_game: (p) => {
      const me = needLogin();
      const g = mock.games.find((x) => x.id === p.p_game_id) || fail('모집글을 찾을 수 없습니다');
      if (g.owner === me.email) fail('내가 쓴 모집글에는 신청할 수 없습니다');
      if (g.is_closed) fail('주최자가 모집을 마감했습니다');
      if (new Date(g.game_at) <= new Date()) fail('이미 시작했거나 끝난 경기입니다');
      if (mock.participants.some((x) => x.game_id === g.id && x.user === me.email)) fail('이미 신청한 경기입니다');
      if (countSide(g.id, 'guest') >= sideMax(g)) fail('게스트측 자리가 모두 찼습니다');
      mock.participants.push({ id: ++seq, game_id: g.id, side: 'guest', nickname: me.nickname, pos: p.p_pos, user: me.email, created_at: new Date().toISOString() });
      return seq;
    },
    leave_game: (p) => {
      const me = needLogin();
      const i = mock.participants.findIndex((x) => x.game_id === p.p_game_id && x.user === me.email);
      if (i < 0) fail('이 경기에 신청한 내역이 없습니다');
      mock.participants.splice(i, 1);
    },
    add_participant: (p) => {
      const g = myGame(p.p_game_id);
      const name = (p.p_nickname || '').trim();
      if (!['host', 'guest'].includes(p.p_side)) fail('주최측 또는 게스트측을 골라 주세요');
      if (!name || name.length > 20) fail('이름은 1자 이상 20자 이하로 입력해 주세요');
      if (countSide(g.id, p.p_side) >= sideMax(g)) {
        fail((p.p_side === 'host' ? '주최측' : '게스트측') + '은 최대 ' + sideMax(g) + '명까지입니다');
      }
      mock.participants.push({ id: ++seq, game_id: g.id, side: p.p_side, nickname: name, pos: p.p_pos, user: null, created_at: new Date().toISOString() });
      return seq;
    },
    kick_participant: (p) => {
      myGame(p.p_game_id);
      const i = mock.participants.findIndex((x) => x.id === p.p_participant_id && x.game_id === p.p_game_id);
      if (i < 0) fail('해당 신청자를 찾을 수 없습니다');
      mock.participants.splice(i, 1);
    },
  };

  async function mockRpc(name, params) {
    const handler = mockHandlers[name] || fail('알 수 없는 함수: ' + name);
    return handler(params);
  }

  const setMockUser = (user) => {
    mock.user = user;
    mock.listeners.forEach((cb) => setTimeout(() => cb(user), 0));
  };
  const mockAuth = {
    async getUser() { return mock.user; },
    async signUp(email, password, nickname) {
      if (mock.users.has(email)) fail('이미 가입된 이메일입니다. 로그인해 주세요.');
      mock.users.set(email, { password, nickname });
      setMockUser({ email, nickname });
      return { needsConfirm: false };
    },
    async signIn(email, password) {
      const found = mock.users.get(email);
      if (!found || found.password !== password) fail('이메일 또는 비밀번호가 틀렸습니다.');
      setMockUser({ email, nickname: found.nickname });
    },
    async signOut() { setMockUser(null); },
    onChange(callback) { mock.listeners.push(callback); },
  };

  window.HoopsApi = { isDemo, callRpc, auth: isDemo ? mockAuth : realAuth };
})();
