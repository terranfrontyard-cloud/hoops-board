// Supabase 연결 + 함수(RPC) 호출 도우미.
// config.js가 비어 있으면 저장되지 않는 예시 데이터로 동작합니다.
(function () {
  'use strict';

  const cfg = window.HOOPS_CONFIG || {};
  const url = String(cfg.SUPABASE_URL || '').trim();
  const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
  const isConfigured = Boolean(url && key);
  const client = isConfigured && window.supabase ? window.supabase.createClient(url, key) : null;

  async function callRpc(name, params) {
    if (!isConfigured) return mockRpc(name, params || {});
    if (!client) throw new Error('Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    const { data, error } = await client.rpc(name, params);
    if (error) throw new Error(toKoreanMessage(error));
    return data;
  }

  function toKoreanMessage(error) {
    // 함수가 없을 때: SQL을 아직 실행하지 않은 경우가 대부분
    if (error.code === 'PGRST202') {
      return '서버 함수를 찾을 수 없습니다. Supabase SQL Editor에서 001_hoops_schema.sql을 실행했는지 확인해 주세요.';
    }
    if (error.code === '23514') return '입력값이 조건에 맞지 않습니다. 글자 수와 숫자 범위를 확인해 주세요.';
    if (/fetch/i.test(error.message || '')) return '서버에 연결할 수 없습니다. 인터넷 연결과 js/config.js 값을 확인해 주세요.';
    // SQL 함수에서 raise exception 으로 보낸 한국어 메시지는 그대로 사용
    return error.message || '알 수 없는 오류가 발생했습니다.';
  }

  // ── 예시 모드 (Supabase 연결 전 화면 확인용, 새로고침하면 사라짐) ──────────
  const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  let seq = 100;
  const mock = {
    games: [
      { id: 1, title: '토요일 저녁 5:5 풀코트, 4명 구합니다', gym_name: '마포구민체육센터', region: '서울 마포구',
        game_at: hoursFromNow(30), duration_min: 120, capacity: 10, reserved_count: 6, fee: 8000, level: '중수',
        description: '주차 2시간 무료, 샤워실 있습니다.\n조끼는 준비해 둘게요. 실내화 꼭 챙겨 주세요.',
        contact: 'https://open.kakao.com/o/example', host_nickname: '대관왕', is_closed: false,
        created_at: hoursFromNow(-5), pw: '1234' },
      { id: 2, title: '평일 퇴근 후 가볍게 뛰실 분', gym_name: '성남 종합운동장 실내체육관', region: '경기 성남시',
        game_at: hoursFromNow(52), duration_min: 90, capacity: 10, reserved_count: 7, fee: 5000, level: '초보',
        description: '초보 환영합니다. 승패보다 즐겁게 뛰는 분위기예요.', contact: '', host_nickname: '점프슛',
        is_closed: false, created_at: hoursFromNow(-20), pw: '1234' },
      { id: 3, title: '일요일 오전 3파전 (15명)', gym_name: '해운대 스포츠센터', region: '부산 해운대구',
        game_at: hoursFromNow(100), duration_min: 180, capacity: 15, reserved_count: 5, fee: 10000, level: '고수',
        description: '', contact: '', host_nickname: '센텀', is_closed: false, created_at: hoursFromNow(-2), pw: '1234' },
    ],
    participants: [
      { id: 11, game_id: 1, nickname: '3점슈터', pos: '가드', pw: '1234', created_at: hoursFromNow(-3) },
      { id: 12, game_id: 1, nickname: '리바운더', pos: '센터', pw: '1234', created_at: hoursFromNow(-2) },
      { id: 13, game_id: 2, nickname: '농린이', pos: '무관', pw: '1234', created_at: hoursFromNow(-9) },
      { id: 14, game_id: 2, nickname: '패스마스터', pos: '가드', pw: '1234', created_at: hoursFromNow(-8) },
      { id: 15, game_id: 2, nickname: '골밑', pos: '포워드', pw: '1234', created_at: hoursFromNow(-1) },
    ],
  };
  const fail = (msg) => { throw new Error(msg); };
  const joinedOf = (id) => mock.participants.filter((p) => p.game_id === id).length;
  const hostGame = (id, pw) =>
    mock.games.find((g) => g.id === id && g.pw === pw) || fail('모집글이 없거나 주최자 비밀번호가 틀렸습니다');
  const gameFields = (p) => ({
    title: p.p_title.trim(), gym_name: p.p_gym_name.trim(), region: (p.p_region || '').trim(),
    game_at: p.p_game_at, duration_min: p.p_duration_min, capacity: p.p_capacity,
    reserved_count: p.p_reserved_count, fee: p.p_fee, level: p.p_level,
    description: (p.p_description || '').trim(), contact: (p.p_contact || '').trim(),
  });

  const mockHandlers = {
    list_games: () => mock.games
      .map(({ pw, ...g }) => ({ ...g, joined_count: joinedOf(g.id) }))
      .sort((a, b) => new Date(a.game_at) - new Date(b.game_at)),
    list_participants: (p) => mock.participants
      .filter((x) => x.game_id === p.p_game_id)
      .map(({ pw, game_id, ...rest }) => rest),
    create_game: (p) => {
      if ((p.p_password || '').length < 4) fail('비밀번호는 4자 이상이어야 합니다');
      const g = { id: ++seq, ...gameFields(p), host_nickname: p.p_nickname.trim(), is_closed: false,
                  created_at: new Date().toISOString(), pw: p.p_password };
      mock.games.push(g);
      return g.id;
    },
    update_game: (p) => {
      const g = hostGame(p.p_id, p.p_password);
      if (p.p_reserved_count + joinedOf(g.id) > p.p_capacity) fail('이미 신청한 인원이 있어 정원을 그보다 줄일 수 없습니다');
      Object.assign(g, gameFields(p));
    },
    delete_game: (p) => {
      const g = hostGame(p.p_id, p.p_password);
      mock.games = mock.games.filter((x) => x !== g);
      mock.participants = mock.participants.filter((x) => x.game_id !== g.id);
    },
    set_game_closed: (p) => { hostGame(p.p_id, p.p_password).is_closed = p.p_closed; },
    join_game: (p) => {
      const g = mock.games.find((x) => x.id === p.p_game_id) || fail('모집글을 찾을 수 없습니다');
      const nick = (p.p_nickname || '').trim();
      if (!nick) fail('닉네임은 1자 이상 20자 이하로 입력해 주세요');
      if ((p.p_password || '').length < 4) fail('비밀번호는 4자 이상이어야 합니다');
      if (g.is_closed) fail('주최자가 모집을 마감했습니다');
      if (new Date(g.game_at) <= new Date()) fail('이미 시작했거나 끝난 경기입니다');
      if (g.reserved_count + joinedOf(g.id) >= g.capacity) fail('정원이 모두 찼습니다');
      if (mock.participants.some((x) => x.game_id === g.id && x.nickname === nick)) fail('이 경기에 같은 닉네임으로 이미 신청했습니다');
      mock.participants.push({ id: ++seq, game_id: g.id, nickname: nick, pos: p.p_pos, pw: p.p_password, created_at: new Date().toISOString() });
      return seq;
    },
    leave_game: (p) => {
      const i = mock.participants.findIndex((x) =>
        x.game_id === p.p_game_id && x.nickname === (p.p_nickname || '').trim() && x.pw === p.p_password);
      if (i < 0) fail('신청 내역이 없거나 비밀번호가 틀렸습니다');
      mock.participants.splice(i, 1);
    },
    kick_participant: (p) => {
      hostGame(p.p_game_id, p.p_password);
      const i = mock.participants.findIndex((x) => x.id === p.p_participant_id && x.game_id === p.p_game_id);
      if (i < 0) fail('해당 신청자를 찾을 수 없습니다');
      mock.participants.splice(i, 1);
    },
  };

  async function mockRpc(name, params) {
    const handler = mockHandlers[name] || fail('알 수 없는 함수: ' + name);
    return handler(params);
  }

  window.HoopsApi = { isConfigured, callRpc };
})();
