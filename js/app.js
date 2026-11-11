// 화면 그리기와 폼 처리.
// 사용자가 입력한 글자는 모두 textContent / 텍스트 노드로만 넣습니다. (innerHTML 사용 안 함)
(function () {
  'use strict';

  const { isDemo, callRpc, auth } = window.HoopsApi;
  const $ = (sel) => document.querySelector(sel);

  const POSITIONS = ['무관', '가드', '포워드', '센터'];

  // 게시판 두 개: 풀코트 5:5 / 반코트 3:3
  const BOARDS = {
    '5v5': {
      label: '풀코트 5:5', sideMax: 5,
      img: 'images/fullcourt-5v5.jpg',
      alt: '풀코트에서 흰색 팀 5명과 주황색 팀 5명이 5:5 경기를 하는 그림',
      title: '대관은 했는데, 10명이 안 채워졌나요?',
      desc: '풀코트 5:5 게임 인원을 모으는 게시판입니다.',
    },
    '3v3': {
      label: '반코트 3:3', sideMax: 3,
      img: 'images/halfcourt-3v3.jpg',
      alt: '반코트에서 흰색 팀 3명과 주황색 팀 3명이 3:3 경기를 하는 그림',
      title: '반코트 3:3, 6명만 모이면 됩니다',
      desc: '반코트 3:3 게임 인원을 모으는 게시판입니다.',
    },
  };
  const boardOf = (g) => (BOARDS[g.game_type] ? g.game_type : '5v5');   // 종류가 없는 예전 글은 5:5

  const state = {
    board: BOARDS[location.hash.slice(1)] ? location.hash.slice(1) : '5v5',
    games: [], filter: 'open', query: '',
    editing: null,        // 수정 중인 모집글 (새 글이면 null)
    user: null,           // 로그인한 회원 { email, nickname }
    isAdmin: false,       // 관리자 여부 (표시용. 실제 권한은 서버가 검사)
    authMode: 'login',    // 'login' | 'signup'
    afterLogin: null,     // 로그인에 성공하면 이어서 실행할 동작
  };

  // ── 작은 도우미들 ─────────────────────────────────────────────
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) node.append(kid); // 문자열은 텍스트 노드로 들어감
    }
    return node;
  }

  const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtWhen = (iso) => `${dateFmt.format(new Date(iso))} ${timeFmt.format(new Date(iso))}`;
  const fmtFee = (n) => (n > 0 ? `${n.toLocaleString('ko-KR')}원` : '무료');
  const fmtDuration = (m) => (m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m / 60}시간`);
  // datetime-local 입력칸은 "현지 시각" 문자열을 쓰므로 변환이 필요
  const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  // 명단은 주최측 / 게스트측으로 나뉘고, 한쪽 최대 인원은 5:5가 5명, 3:3이 3명.
  // 회원의 참가 신청은 게스트측으로만 들어가므로 "모집중" 여부는 게스트측 빈자리로 판단
  function statusOf(g) {
    const max = g.side_max || BOARDS[boardOf(g)].sideMax;
    const hostCount = g.host_count || 0;
    const guestCount = g.guest_count || 0;
    const base = {
      max, hostCount, guestCount,
      filled: hostCount + guestCount,
      total: max * 2,
      left: Math.max(0, max - guestCount),          // 게스트측 빈자리
    };
    if (new Date(g.game_at) <= new Date()) return { ...base, key: 'past', label: '종료' };
    if (g.is_closed) return { ...base, key: 'closed', label: '마감' };
    if (base.left === 0) return { ...base, key: 'full', label: '모집 완료' };
    if (base.left === 1) return { ...base, key: 'almost', label: '마감 임박 · 1자리' };
    return { ...base, key: 'open', label: '모집중' };
  }
  const isJoinable = (s) => s.key === 'open' || s.key === 'almost';

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function showError(node, msg) {
    node.textContent = msg || '';
    node.hidden = !msg;
  }

  // 버튼을 잠그고 작업을 실행, 실패하면 errNode에 메시지를 보여줌
  async function run(button, errNode, task) {
    showError(errNode, '');
    button.disabled = true;
    try {
      await task();
    } catch (err) {
      showError(errNode, err.message);
    } finally {
      button.disabled = false;
    }
  }

  // ── 목록 ─────────────────────────────────────────────────────
  async function loadGames() {
    try {
      state.games = (await callRpc('list_games')) || [];
      showError($('#list-error'), '');
    } catch (err) {
      showError($('#list-error'), err.message);
    }
    renderList();
  }

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const rows = state.games
      .filter((g) => boardOf(g) === state.board)
      .map((g) => ({ g, s: statusOf(g) }))
      .filter(({ s }) => state.filter === 'all' || isJoinable(s))
      .filter(({ g }) => !q || `${g.region} ${g.gym_name} ${g.title}`.toLowerCase().includes(q));

    // 예정된 경기는 가까운 순, 지난 경기는 맨 뒤(최근 것부터)
    const upcoming = rows.filter(({ s }) => s.key !== 'past');
    const past = rows.filter(({ s }) => s.key === 'past').reverse();

    const list = $('#list');
    list.replaceChildren(...[...upcoming, ...past].map(({ g, s }) => card(g, s)));
    if (!list.children.length) {
      list.append(el('p', { class: 'empty' },
        q ? '검색 결과가 없습니다.' :
        state.filter === 'open'
          ? `지금 모집 중인 ${BOARDS[state.board].label} 게임이 없습니다. 첫 모집글을 올려 보세요!`
          : `등록된 ${BOARDS[state.board].label} 모집글이 없습니다.`));
    }
  }

  // 게시판(5:5 / 3:3)을 바꾸면 탭, 사진, 문구, 목록을 함께 바꿈
  function setBoard(board) {
    state.board = board;
    const info = BOARDS[board];
    document.querySelectorAll('.boards button').forEach((b) => {
      const on = b.dataset.board === board;
      b.classList.toggle('current', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const img = $('#hero-img');
    if (img.getAttribute('src') !== info.img) img.setAttribute('src', info.img);
    img.alt = info.alt;
    $('#hero-title').textContent = info.title;
    $('#hero-desc').textContent = info.desc;
    if (location.hash.slice(1) !== board) history.replaceState(null, '', `#${board}`);
    renderList();
  }

  function card(g, s) {
    const pct = Math.min(100, Math.round((s.filled / s.total) * 100));
    return el('button', { class: `card${isJoinable(s) ? '' : ' dim'}`, type: 'button', onclick: () => openDetail(g.id) },
      el('div', { class: 'card-top' },
        el('span', { class: 'when' }, fmtWhen(g.game_at)),
        el('span', { class: `badge ${s.key}` }, s.label)),
      el('h3', null, g.title),
      el('p', { class: 'meta' }, [g.gym_name, g.region].filter(Boolean).join(' · ')),
      el('p', { class: 'meta' }, [fmtFee(g.fee), `수준 ${g.level}`, fmtDuration(g.duration_min), g.is_mine && '내 글', g.i_joined && !g.is_mine && '신청함'].filter(Boolean).join(' · ')),
      el('div', { class: 'fill' },
        el('div', { class: 'fill-text' },
          el('span', null, el('b', null, String(s.filled)), ` / ${s.total}명`),
          el('span', null, s.left > 0 ? `게스트 ${s.left}자리 남음` : '게스트 자리 없음')),
        el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` }))));
  }

  // ── 상세 ─────────────────────────────────────────────────────
  async function openDetail(id) {
    const g = state.games.find((x) => x.id === id);
    if (!g) return;
    const dlg = $('#detail');
    let people = [];
    let loadError = '';
    try {
      people = (await callRpc('list_participants', { p_game_id: id })) || [];
    } catch (err) {
      loadError = err.message;
    }
    dlg.replaceChildren(detailView(g, people, loadError));
    if (!dlg.open) dlg.showModal();
  }

  // 작업 후 목록과 상세를 함께 새로 고침
  async function refresh(id) {
    await loadGames();
    if (state.games.some((x) => x.id === id)) await openDetail(id);
    else $('#detail').close();
  }

  function contactNode(text) {
    if (/^https?:\/\/\S+$/i.test(text)) {
      return el('a', { href: text, target: '_blank', rel: 'noopener noreferrer' }, text);
    }
    return text;
  }

  function detailView(g, people, loadError) {
    const s = statusOf(g);
    const facts = el('dl', { class: 'facts' },
      el('dt', null, '종류'), el('dd', null, BOARDS[boardOf(g)].label),
      el('dt', null, '일시'), el('dd', null, `${fmtWhen(g.game_at)} (${fmtDuration(g.duration_min)})`),
      el('dt', null, '장소'), el('dd', null, [g.gym_name, g.region].filter(Boolean).join(' · ')),
      el('dt', null, '참가비'), el('dd', null, fmtFee(g.fee)),
      el('dt', null, '수준'), el('dd', null, g.level),
      el('dt', null, '주최'), el('dd', null, g.host_nickname),
      g.contact && el('dt', null, '연락'), g.contact && el('dd', null, contactNode(g.contact)));

    // 한쪽 명단: 이름들 + 남은 자리만큼 "빈자리"
    const sideList = (side, title) => {
      const members = people.filter((p) => (p.side || 'guest') === side);
      return el('div', { class: `side ${side}` },
        el('div', { class: 'side-title' }, title, el('span', null, `${members.length} / ${s.max}명`)),
        el('ul', { class: 'roster' },
          members.map((p) => el('li', { class: [side === 'host' && 'host', p.is_me && 'me'].filter(Boolean).join(' ') || null },
            p.nickname, el('small', null, p.is_me ? `${p.pos} · 나` : p.pos))),
          Array.from({ length: Math.max(0, s.max - members.length) }, () => el('li', { class: 'free' }, '빈자리'))));
    };
    const roster = el('div', { class: 'sides' }, sideList('host', '주최측'), sideList('guest', '게스트측'));

    return el('div', { class: 'detail' },
      el('div', { class: 'dialog-head' },
        el('div', null,
          el('span', { class: `badge ${s.key}` }, s.label),
          el('h2', { id: 'detail-title' }, g.title)),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', onclick: () => $('#detail').close() }, '✕')),
      facts,
      g.description && el('p', { class: 'desc' }, g.description),
      el('div', { class: 'section-title' }, '참가 명단', el('span', null, `${s.filled} / ${s.total}명`)),
      loadError && el('p', { class: 'errors' }, loadError),
      roster,
      canManage(g) && hostPanel(g, people, s),   // 글 주인과 관리자에게만 관리 메뉴 표시
      // 내 글이면 신청 불가, 이미 신청했으면 취소, 그 외에는 신청
      g.is_mine ? null
        : g.i_joined ? leavePanel(g)
        : isJoinable(s) ? joinPanel(g)
        : el('p', { class: 'hint' }, '지금은 참가 신청을 받지 않는 게임입니다.'));
  }

  // 참가 신청 (회원 전용). 닉네임은 회원가입 때 적은 값을 서버가 사용함
  function joinPanel(g) {
    if (!state.user) {
      return el('div', { class: 'panel' },
        el('h3', null, '참가 신청'),
        el('p', { class: 'hint' }, '참가 신청은 회원만 할 수 있습니다.'),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => {
            $('#detail').close();
            openAuth('login', '참가 신청을 하려면 로그인이 필요합니다.', () => openDetail(g.id));
          } }, '로그인하고 신청하기')));
    }

    const pos = el('select', null, POSITIONS.map((p) => el('option', null, p)));
    const err = el('p', { class: 'errors', hidden: true });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, '참가 신청');
    return el('form', { class: 'panel', onsubmit: (e) => {
      e.preventDefault();
      run(btn, err, async () => {
        await callRpc('join_game', { p_game_id: g.id, p_pos: pos.value });
        toast('참가 신청이 완료됐습니다');
        await refresh(g.id);
      });
    } },
      el('h3', null, '참가 신청'),
      el('p', { class: 'hint' }, `${state.user.nickname} 님 이름으로 게스트측에 신청됩니다.`),
      el('div', { class: 'inline' }, el('label', null, '포지션', pos), btn),
      err);
  }

  function leavePanel(g) {
    const err = el('p', { class: 'errors', hidden: true });
    const btn = el('button', { class: 'btn', type: 'button', onclick: () => {
      if (!confirm('참가 신청을 취소할까요?')) return;
      run(btn, err, async () => {
        await callRpc('leave_game', { p_game_id: g.id });
        toast('신청을 취소했습니다');
        await refresh(g.id);
      });
    } }, '신청 취소');
    return el('div', { class: 'panel' },
      el('h3', null, '참가 신청을 완료했습니다'),
      el('div', { class: 'actions' }, btn),
      err);
  }

  // 이 글을 관리할 수 있는지: 내 글이거나 관리자 (006 SQL 실행 전에는 내 글만)
  const canManage = (g) => (g.can_manage == null ? Boolean(g.is_mine) : g.can_manage);

  // 글 주인과 관리자에게만 보이는 관리 메뉴. 권한은 서버에서 다시 검사함
  function hostPanel(g, people, s) {
    const err = el('p', { class: 'errors', hidden: true });

    // 명단에 이름 직접 추가: 주최측 / 게스트측을 골라 넣음 (한쪽 최대 s.max명)
    const hostFull = s.hostCount >= s.max;
    const guestFull = s.guestCount >= s.max;
    const sideSel = el('select', null,
      el('option', { value: 'host', disabled: hostFull }, `주최측 (${s.hostCount}/${s.max})`),
      el('option', { value: 'guest', disabled: guestFull, selected: hostFull && !guestFull }, `게스트측 (${s.guestCount}/${s.max})`));
    const nameInput = el('input', { maxlength: 20, required: true, placeholder: '이름 또는 닉네임' });
    const posSel = el('select', null, POSITIONS.map((p) => el('option', null, p)));
    const addBtn = el('button', { class: 'btn small primary', type: 'submit' }, '추가');
    const addForm = hostFull && guestFull
      ? el('p', { class: 'hint' }, `주최측과 게스트측이 모두 ${s.max}명으로 찼습니다.`)
      : el('form', { class: 'inline', onsubmit: (e) => {
          e.preventDefault();
          run(addBtn, err, async () => {
            if (!nameInput.value.trim()) throw new Error('이름을 입력해 주세요');
            await callRpc('add_participant', {
              p_game_id: g.id, p_side: sideSel.value, p_nickname: nameInput.value, p_pos: posSel.value });
            toast(`${sideSel.value === 'host' ? '주최측' : '게스트측'}에 추가했습니다`);
            await refresh(g.id);
          });
        } },
          el('label', null, '어느 쪽', sideSel),
          el('label', null, '이름', nameInput),
          el('label', null, '포지션', posSel),
          addBtn);

    const editBtn = el('button', { class: 'btn small', type: 'button', onclick: () => openForm(g) }, '수정');

    const closeBtn = el('button', { class: 'btn small', type: 'button', onclick: () => {
      run(closeBtn, err, async () => {
        await callRpc('set_game_closed', { p_id: g.id, p_closed: !g.is_closed });
        toast(g.is_closed ? '모집을 다시 열었습니다' : '모집을 마감했습니다');
        await refresh(g.id);
      });
    } }, g.is_closed ? '모집 다시 열기' : '모집 마감');

    const delBtn = el('button', { class: 'btn small danger', type: 'button', onclick: () => {
      if (!confirm('모집글과 참가 신청이 모두 삭제됩니다. 삭제할까요?')) return;
      run(delBtn, err, async () => {
        await callRpc('delete_game', { p_id: g.id });
        toast('모집글을 삭제했습니다');
        await refresh(g.id);
      });
    } }, '삭제');

    let kickRow = null;
    if (people.length) {
      const select = el('select', null, people.map((p) =>
        el('option', { value: p.id }, `[${p.side === 'host' ? '주최측' : '게스트측'}] ${p.nickname} (${p.pos})`)));
      const kickBtn = el('button', { class: 'btn small', type: 'button', onclick: () => {
        run(kickBtn, err, async () => {
          await callRpc('kick_participant', { p_game_id: g.id, p_participant_id: Number(select.value) });
          toast('명단에서 뺐습니다');
          await refresh(g.id);
        });
      } }, '명단에서 빼기');
      kickRow = el('div', { class: 'inline' }, el('label', null, '명단에서 빼기', select), kickBtn);
    }

    return el('div', { class: 'panel' },
      el('h3', null, g.is_mine ? '내 모집글 관리' : '관리자 메뉴'),
      !g.is_mine && el('p', { class: 'hint' }, `관리자 권한으로 ${g.host_nickname} 님의 글을 관리합니다.`),
      el('div', { class: 'inline' }, editBtn, closeBtn, delBtn),
      el('h3', null, '참가 명단에 추가'),
      addForm,
      kickRow, err);
  }

  // ── 모집글 쓰기 / 수정 (회원 전용) ───────────────────────────
  function openForm(game) {
    if (!state.user) {
      openAuth('login', '모집글을 쓰려면 로그인이 필요합니다.', () => openForm());
      return;
    }
    state.editing = game || null;
    const form = $('#game-form');
    form.reset();
    showError($('#form-error'), '');

    $('#form-title').textContent = game ? '모집글 수정' : '모집글 쓰기';
    $('#form-submit').textContent = game ? '수정 저장' : '등록';
    $('#f-date').min = toLocalInput(new Date());

    // 새 글은 지금 보고 있는 게시판 종류로 시작
    $('#f-type').value = game ? boardOf(game) : state.board;
    renderSizeHint();

    if (game) {
      $('#f-title').value = game.title;
      $('#f-gym').value = game.gym_name;
      $('#f-region').value = game.region;
      $('#f-date').value = toLocalInput(new Date(game.game_at));
      const dur = $('#f-duration');
      if (![...dur.options].some((o) => Number(o.value) === game.duration_min)) {
        dur.append(el('option', { value: game.duration_min }, fmtDuration(game.duration_min)));
      }
      dur.value = game.duration_min;
      $('#f-fee').value = game.fee;
      $('#f-level').value = game.level;
      $('#f-desc').value = game.description;
      $('#f-contact').value = game.contact;
      $('#detail').close();
    }
    $('#game-dialog').showModal();
  }

  function readForm() {
    const dateValue = $('#f-date').value;
    const num = (sel) => Number($(sel).value);
    const v = {
      p_game_type: $('#f-type').value,
      p_title: $('#f-title').value.trim(),
      p_gym_name: $('#f-gym').value.trim(),
      p_region: $('#f-region').value.trim(),
      p_game_at: dateValue ? new Date(dateValue).toISOString() : null,
      p_duration_min: num('#f-duration'),
      p_fee: num('#f-fee'),
      p_level: $('#f-level').value,
      p_description: $('#f-desc').value,
      p_contact: $('#f-contact').value.trim(),
    };
    // 서버에서도 다시 검사하지만, 흔한 실수는 바로 알려 줌
    if (v.p_title.length < 2) throw new Error('제목을 2자 이상 입력해 주세요');
    if (!v.p_gym_name) throw new Error('체육관 이름을 입력해 주세요');
    if (!v.p_game_at) throw new Error('경기 일시를 정해 주세요');
    if (new Date(v.p_game_at) <= new Date()) throw new Error('경기 일시는 지금 이후로 정해 주세요');
    if (!Number.isInteger(v.p_fee) || v.p_fee < 0) throw new Error('참가비를 0 이상의 숫자로 입력해 주세요');
    return v;
  }

  $('#game-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const game = state.editing;
    run($('#form-submit'), $('#form-error'), async () => {
      const values = readForm();
      if (game) {
        await callRpc('update_game', { p_id: game.id, ...values });
        toast('모집글을 수정했습니다');
      } else {
        await callRpc('create_game', values);
        toast('모집글을 등록했습니다');
      }
      $('#game-dialog').close();
      await loadGames();
      setBoard(values.p_game_type);   // 방금 쓴 글이 있는 게시판으로 이동
    });
  });

  // 게임 종류에 따라 정원이 정해짐을 폼에 안내
  function renderSizeHint() {
    const max = BOARDS[$('#f-type').value].sideMax;
    $('#f-size-hint').textContent =
      `정원은 주최측 ${max}명 + 게스트측 ${max}명입니다. 글을 올리면 내가 주최측 첫 번째로 들어가고, ` +
      '나머지 이름은 글을 연 뒤 "내 모집글 관리"에서 추가합니다.';
  }
  $('#f-type').addEventListener('change', renderSizeHint);

  // ── 로그인 / 회원가입 ────────────────────────────────────────
  function renderAuth() {
    const user = state.user;
    $('#btn-login').hidden = Boolean(user);
    $('#btn-logout').hidden = !user;
    $('#user-nick').hidden = !user;
    $('#user-nick').textContent = user ? `${user.nickname} 님` : '';
    $('#admin-badge').hidden = !(user && state.isAdmin);
  }

  // 로그인한 사람이 관리자인지 서버에 물어봄 (실패하면 일반 회원으로 취급)
  async function fetchIsAdmin(user) {
    if (!user) return false;
    try {
      return Boolean(await callRpc('is_admin'));
    } catch {
      return false;
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const signup = mode === 'signup';
    $('#auth-title').textContent = signup ? '회원가입' : '로그인';
    $('#auth-submit').textContent = signup ? '가입하기' : '로그인';
    $('#auth-switch').textContent = signup ? '이미 회원이신가요? 로그인' : '처음이신가요? 회원가입';
    $('#a-nick-wrap').hidden = !signup;
    $('#a-pw').autocomplete = signup ? 'new-password' : 'current-password';
    showError($('#auth-error'), '');
  }

  // reason: 로그인 창 위에 보여줄 안내, afterLogin: 로그인 성공 뒤 이어서 할 동작
  function openAuth(mode, reason, afterLogin) {
    state.afterLogin = afterLogin || null;
    $('#auth-form').reset();
    showError($('#auth-reason'), reason);
    $('#auth-info').hidden = true;
    setAuthMode(mode);
    $('#auth-dialog').showModal();
  }

  // 로그인 상태가 바뀌면 화면과 목록("내 글" 표시)을 갱신
  async function applyUser(user) {
    const changed = (state.user?.email || '') !== (user?.email || '');
    state.user = user;
    if (!changed) return;
    state.isAdmin = false;
    renderAuth();
    state.isAdmin = await fetchIsAdmin(user);
    renderAuth();
    await loadGames();
  }

  $('#auth-switch').addEventListener('click', () => {
    $('#auth-info').hidden = true;
    setAuthMode(state.authMode === 'signup' ? 'login' : 'signup');
  });

  $('#auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    run($('#auth-submit'), $('#auth-error'), async () => {
      const email = $('#a-email').value.trim();
      const password = $('#a-pw').value;
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('이메일 주소를 정확히 입력해 주세요');
      if (password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다');

      if (state.authMode === 'signup') {
        const nickname = $('#a-nick').value.trim();
        if (!nickname) throw new Error('닉네임을 입력해 주세요');
        const { needsConfirm } = await auth.signUp(email, password, nickname);
        if (needsConfirm) {
          // 이메일 인증을 켜 둔 경우: 메일의 링크를 눌러야 로그인됨
          setAuthMode('login');
          $('#a-pw').value = '';
          $('#auth-info').textContent = `${email} 로 인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.`;
          $('#auth-info').hidden = false;
          return;
        }
        toast('가입을 환영합니다!');
      } else {
        await auth.signIn(email, password);
        toast('로그인했습니다');
      }

      await applyUser(await auth.getUser());   // 목록의 "내 글"·"신청함" 표시까지 갱신
      $('#auth-dialog').close();
      const next = state.afterLogin;
      state.afterLogin = null;
      if (next) next();
    });
  });

  $('#btn-login').addEventListener('click', () => openAuth('login'));
  $('#btn-logout').addEventListener('click', async () => {
    try {
      await auth.signOut();
      applyUser(null);
      toast('로그아웃했습니다');
    } catch (err) {
      toast(err.message);
    }
  });

  // ── 이벤트 연결 ──────────────────────────────────────────────
  $('#btn-new').addEventListener('click', () => openForm());

  document.querySelectorAll('.boards button').forEach((btn) => {
    btn.addEventListener('click', () => setBoard(btn.dataset.board));
  });
  window.addEventListener('hashchange', () => {
    const board = location.hash.slice(1);
    if (BOARDS[board] && board !== state.board) setBoard(board);
  });

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('current', b === btn));
      renderList();
    });
  });

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });

  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      // 바깥 어두운 영역을 누르거나 [data-close] 버튼을 누르면 닫기
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  });

  // 다른 탭에 다녀오면 최신 인원으로 갱신
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !document.querySelector('dialog[open]')) loadGames();
  });

  // ── 시작 ─────────────────────────────────────────────────────
  $('#setup').hidden = !isDemo;
  setBoard(state.board);
  $('#list').replaceChildren(el('p', { class: 'empty' }, '불러오는 중…'));

  (async () => {
    try {
      state.user = await auth.getUser();   // 저장된 로그인 정보가 있으면 복원
    } catch {
      state.user = null;
    }
    state.isAdmin = await fetchIsAdmin(state.user);
    renderAuth();
    auth.onChange(applyUser);              // 메일 인증 링크로 돌아왔을 때, 다른 탭에서 로그아웃했을 때 등
    await loadGames();
  })();
})();
