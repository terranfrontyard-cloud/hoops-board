-- =====================================================================
-- 003_join_requires_login.sql
-- 훕스보드: 참가 신청도 회원 전용으로 변경
--
-- 사용법: 001, 002 를 실행한 뒤,
--         Supabase → SQL Editor → 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다.
--
-- 바뀌는 점
--   1) 참가 신청·취소는 로그인한 회원만 할 수 있습니다. (목록·명단 보기는 누구나)
--   2) 신청자는 닉네임+비밀번호가 아니라 회원 계정으로 구분합니다.
--      닉네임은 회원가입 때 적은 값을 쓰고, 한 경기에 한 번만 신청할 수 있습니다.
--   3) 자기가 쓴 모집글에는 신청할 수 없습니다. (주최자는 "확보된 인원"에 이미 포함)
--   4) 이 파일 실행 전에 비밀번호 방식으로 신청한 사람은 스스로 취소할 수 없고,
--      글 주인이 "내보내기"로만 뺄 수 있습니다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 신청자에 회원 칸 추가
--    닉네임은 회원끼리 겹칠 수 있으므로 "경기당 같은 닉네임 금지"를
--    "경기당 같은 회원 금지"로 교체
-- ---------------------------------------------------------------------
alter table public.participants
  add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table public.participants alter column pw_hash drop not null;

alter table public.participants drop constraint if exists participants_game_id_nickname_key;
create unique index if not exists participants_game_user_key
  on public.participants (game_id, user_id);   -- user_id 가 비어 있는 예전 신청은 제한 없음


-- ---------------------------------------------------------------------
-- ② 비밀번호 방식의 예전 함수 제거
-- ---------------------------------------------------------------------
drop function if exists public.join_game(bigint,text,text,text);
drop function if exists public.leave_game(bigint,text,text);


-- ---------------------------------------------------------------------
-- ③ 목록 조회: 내가 신청한 경기인지(i_joined) 함께 알려 줌
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz,
  is_mine boolean, i_joined boolean
)
language sql stable security definer set search_path = public as $$
  select g.id, g.title, g.gym_name, g.region, g.game_at,
         g.duration_min, g.capacity, g.reserved_count,
         (select count(*)::integer from participants p where p.game_id = g.id),
         g.fee, g.level, g.description, g.contact,
         g.host_nickname, g.is_closed, g.created_at,
         coalesce(g.host_user_id = auth.uid(), false),
         exists (select 1 from participants p where p.game_id = g.id and p.user_id = auth.uid())
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ④ 참가자 명단: 나인지(is_me) 함께 알려 줌. 회원 ID는 내보내지 않음
-- ---------------------------------------------------------------------
drop function if exists public.list_participants(bigint);
create function public.list_participants(p_game_id bigint)
returns table (id bigint, nickname text, pos text, created_at timestamptz, is_me boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.nickname, p.pos, p.created_at,
         coalesce(p.user_id = auth.uid(), false)
    from participants p
   where p.game_id = p_game_id
   order by p.created_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑤ 참가 신청 (회원 전용)
--    게임 행을 잠근 뒤 자리를 세기 때문에 동시에 눌러도 정원을 넘지 않음
-- ---------------------------------------------------------------------
create or replace function public.join_game(p_game_id bigint, p_pos text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := require_login();
  v_nick   text := left(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'nickname'), ''), '회원'), 20);
  v_game   games%rowtype;
  v_joined integer;
  v_id     bigint;
begin
  if p_pos is null or p_pos not in ('무관', '가드', '포워드', '센터') then
    raise exception '포지션 값이 올바르지 않습니다';
  end if;

  select * into v_game from games where id = p_game_id for update;
  if not found then
    raise exception '모집글을 찾을 수 없습니다';
  end if;
  if v_game.host_user_id = v_uid then
    raise exception '내가 쓴 모집글에는 신청할 수 없습니다';
  end if;
  if v_game.is_closed then
    raise exception '주최자가 모집을 마감했습니다';
  end if;
  if v_game.game_at <= now() then
    raise exception '이미 시작했거나 끝난 경기입니다';
  end if;
  if exists (select 1 from participants where game_id = p_game_id and user_id = v_uid) then
    raise exception '이미 신청한 경기입니다';
  end if;

  select count(*) into v_joined from participants where game_id = p_game_id;
  if v_game.reserved_count + v_joined >= v_game.capacity then
    raise exception '정원이 모두 찼습니다';
  end if;

  insert into participants (game_id, nickname, pos, user_id)
  values (p_game_id, v_nick, p_pos, v_uid)
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑥ 참가 취소 (내 신청만)
-- ---------------------------------------------------------------------
create or replace function public.leave_game(p_game_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_login();
begin
  delete from participants where game_id = p_game_id and user_id = v_uid;
  if not found then
    raise exception '이 경기에 신청한 내역이 없습니다';
  end if;
end; $$;


-- ---------------------------------------------------------------------
-- ⑦ 권한: 보기는 누구나, 신청·취소는 로그인한 회원만
-- ---------------------------------------------------------------------
grant execute on function public.list_games()              to anon, authenticated;
grant execute on function public.list_participants(bigint) to anon, authenticated;

revoke execute on function public.join_game(bigint,text) from public, anon;
revoke execute on function public.leave_game(bigint)     from public, anon;
grant  execute on function public.join_game(bigint,text) to authenticated;
grant  execute on function public.leave_game(bigint)     to authenticated;

-- 함수 목록이 바뀌었음을 API 서버에 알림
notify pgrst, 'reload schema';
