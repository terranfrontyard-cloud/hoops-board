// 화면 그리기와 폼 처리.
// 사용자가 입력한 글자는 모두 textContent / 텍스트 노드로만 넣습니다. (innerHTML 사용 안 함)
(function () {
  'use strict';

  const { isDemo, callRpc, auth } = window.HoopsApi;
  const $ = (sel) => document.querySelector(sel);

  const POSITIONS = ['무관', '가드', '포워드', '센터'];
  const state = {
    games: [], filter: 'open', query: '',
    editing: null,        // 수정 중인 모집글 (새 글이면 null)
    user: null,           // 로그인한 회원 { email, nickname }
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

  function statusOf(g) {
    const filled = g.reserved_count + g.joined_count;
    const left = Math.max(0, g.capacity - filled);
    if (new Date(g.game_at) <= new Date()) return { key: 'past', label: '종료', left, filled };
    if (g.is_closed) return { key: 'closed', label: '마감', left, filled };
    if (left === 0) return { key: 'full', label: '모집 완료', left, filled };
    if (left <= 2) return { key: 'almost', label: `마감 임박 · ${left}자리`, left, filled };
    return { key: 'open', label: '모집중', left, filled };
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
        state.filter === 'open' ? '지금 모집 중인 게임이 없습니다. 첫 모집글을 올려 보세요!' : '등록된 모집글이 없습니다.'));
    }
  }

  function card(g, s) {
    const pct = Math.min(100, Math.round((s.filled / g.capacity) * 100));
    return el('button', { class: `card${isJoinable(s) ? '' : ' dim'}`, type: 'button', onclick: () => openDetail(g.id) },
      el('div', { class: 'card-top' },
        el('span', { class: 'when' }, fmtWhen(g.game_at)),
        el('span', { class: `badge ${s.key}` }, s.label)),
      el('h3', null, g.title),
      el('p', { class: 'meta' }, [g.gym_name, g.region].filter(Boolean).join(' · ')),
      el('p', { class: 'meta' }, [fmtFee(g.fee), `수준 ${g.level}`, fmtDuration(g.duration_min), g.is_mine && '내 글', g.i_joined && '신청함'].filter(Boolean).join(' · ')),
      el('div', { class: 'fill' },
        el('div', { class: 'fill-text' },
          el('span', null, el('b', null, String(s.filled)), ` / ${g.capacity}명`),
          el('span', null, s.left > 0 ? `${s.left}자리 남음` : '자리 없음')),
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
      el('dt', null, '일시'), el('dd', null, `${fmtWhen(g.game_at)} (${fmtDuration(g.duration_min)})`),
      el('dt', null, '장소'), el('dd', null, [g.gym_name, g.region].filter(Boolean).join(' · ')),
      el('dt', null, '참가비'), el('dd', null, fmtFee(g.fee)),
      el('dt', null, '수준'), el('dd', null, g.level),
      el('dt', null, '주최'), el('dd', null, g.host_nickname),
      g.contact && el('dt', null, '연락'), g.contact && el('dd', null, contactNode(g.contact)));

    const roster = el('ul', { class: 'roster' },
      Array.from({ length: g.reserved_count }, (_, i) =>
        el('li', { class: 'host' }, i === 0 ? g.host_nickname : '주최 측', el('small', null, i === 0 ? '주최자' : '확보된 인원'))),
      people.map((p) => el('li', { class: p.is_me && 'me' }, p.nickname, el('small', null, p.is_me ? `${p.pos} · 나` : p.pos))),
      Array.from({ length: s.left }, () => el('li', { class: 'free' }, '빈자리')));

    return el('div', { class: 'detail' },
      el('div', { class: 'dialog-head' },
        el('div', null,
          el('span', { class: `badge ${s.key}` }, s.label),
          el('h2', { id: 'detail-title' }, g.title)),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', onclick: () => $('#detail').close() }, '✕')),
      facts,
      g.description && el('p', { class: 'desc' }, g.description),
      el('div', { class: 'section-title' }, '참가 명단', el('span', null, `${s.filled} / ${g.capacity}명`)),
      loadError && el('p', { class: 'errors' }, loadError),
      roster,
      g.is_mine && hostPanel(g, people),   // 내가 쓴 글에만 관리 메뉴 표시
      // 이미 신청했으면 취소, 내 글이면 신청 불가, 그 외에는 신청
      g.i_joined ? leavePanel(g)
        : g.is_mine ? null
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
      el('p', { class: 'hint' }, `${state.user.nickname} 님 이름으로 신청됩니다.`),
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

  // 글 주인(로그인한 회원)에게만 보이는 관리 메뉴. 권한은 서버에서 다시 검사함
  function hostPanel(g, people) {
    const err = el('p', { class: 'errors', hidden: true });

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
      const select = el('select', null, people.map((p) => el('option', { value: p.id }, `${p.nickname} (${p.pos})`)));
      const kickBtn = el('button', { class: 'btn small', type: 'button', onclick: () => {
        run(kickBtn, err, async () => {
          await callRpc('kick_participant', { p_game_id: g.id, p_participant_id: Number(select.value) });
          toast('신청자를 내보냈습니다');
          await refresh(g.id);
        });
      } }, '내보내기');
      kickRow = el('div', { class: 'inline' }, el('label', null, '신청자 내보내기', select), kickBtn);
    }

    return el('div', { class: 'panel' },
      el('h3', null, '내 모집글 관리'),
      el('div', { class: 'inline' }, editBtn, closeBtn, delBtn),
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
      $('#f-capacity').value = game.capacity;
      $('#f-reserved').value = game.reserved_count;
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
      p_title: $('#f-title').value.trim(),
      p_gym_name: $('#f-gym').value.trim(),
      p_region: $('#f-region').value.trim(),
      p_game_at: dateValue ? new Date(dateValue).toISOString() : null,
      p_duration_min: num('#f-duration'),
      p_capacity: num('#f-capacity'),
      p_reserved_count: num('#f-reserved'),
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
    if (!Number.isInteger(v.p_capacity) || v.p_capacity < 2 || v.p_capacity > 30) throw new Error('정원은 2~30명으로 정해 주세요');
    if (!Number.isInteger(v.p_reserved_count) || v.p_reserved_count < 0 || v.p_reserved_count > v.p_capacity) {
      throw new Error('확보된 인원은 0명 이상, 정원 이하로 입력해 주세요');
    }
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
    });
  });

  // ── 로그인 / 회원가입 ────────────────────────────────────────
  function renderAuth() {
    const user = state.user;
    $('#btn-login').hidden = Boolean(user);
    $('#btn-logout').hidden = !user;
    $('#user-nick').hidden = !user;
    $('#user-nick').textContent = user ? `${user.nickname} 님` : '';
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
  function applyUser(user) {
    const changed = (state.user?.email || '') !== (user?.email || '');
    state.user = user;
    renderAuth();
    return changed ? loadGames() : Promise.resolve();
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
  $('#list').append(el('p', { class: 'empty' }, '불러오는 중…'));

  (async () => {
    try {
      state.user = await auth.getUser();   // 저장된 로그인 정보가 있으면 복원
    } catch {
      state.user = null;
    }
    renderAuth();
    auth.onChange(applyUser);              // 메일 인증 링크로 돌아왔을 때, 다른 탭에서 로그아웃했을 때 등
    await loadGames();
  })();
})();
