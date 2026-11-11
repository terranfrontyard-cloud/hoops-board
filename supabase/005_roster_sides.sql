-- =====================================================================
-- 005_roster_sides.sql
-- 훕스보드: 참가 명단을 주최측 / 게스트측으로 분리
--
-- 사용법: 001 ~ 004 를 실행한 뒤,
--         Supabase → SQL Editor → 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다.
--
-- 바뀌는 점
--   1) 명단의 모든 사람은 주최측(host) 또는 게스트측(guest) 중 한쪽에 속합니다.
--   2) 한쪽 최대 인원: 풀코트 5:5 는 5명, 반코트 3:3 은 3명.
--      정원은 그 두 배(10명 / 6명)로 고정됩니다.
--   3) 글 주인은 "내 모집글 관리"에서 이름을 직접 적어 어느 쪽에든 넣을 수 있습니다.
--      (회원이 아닌 지인도 이름만 적어 추가 가능)
--   4) 회원이 누르는 "참가 신청"은 항상 게스트측으로 들어갑니다.
--   5) 글을 쓰면 글쓴이가 주최측 첫 번째 사람으로 자동 등록됩니다.
--   6) 예전의 "확보된 인원" 숫자는 주최측 명단으로 옮겨집니다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 한쪽 최대 인원 (게임 종류별)
-- ---------------------------------------------------------------------
create or replace function public.side_max(p_game_type text)
returns integer
language sql immutable as $$
  select case when p_game_type = '3v3' then 3 else 5 end;
$$;


-- ---------------------------------------------------------------------
-- ② 명단에 "어느 쪽인지" 칸 추가 (기존 신청자는 게스트측)
-- ---------------------------------------------------------------------
alter table public.participants
  add column if not exists side text not null default 'guest';

alter table public.participants drop constraint if exists participants_side_check;
alter table public.participants add constraint participants_side_check check (side in ('host', 'guest'));


-- ---------------------------------------------------------------------
-- ③ 예전 글 옮기기: "확보된 인원" 숫자 → 주최측 명단, 정원은 한쪽 최대의 두 배
--    (옮긴 뒤 숫자를 0으로 만들기 때문에 다시 실행해도 중복되지 않음)
-- ---------------------------------------------------------------------
insert into public.participants (game_id, nickname, pos, side, user_id)
select g.id,
       case when n = 1 then g.host_nickname else '주최측 ' || n end,
       '무관', 'host',
       case when n = 1 then g.host_user_id end
  from public.games g
 cross join lateral generate_series(1, least(g.reserved_count, public.side_max(g.game_type))) as n
 where g.reserved_count > 0
   and not exists (select 1 from public.participants p where p.game_id = g.id and p.side = 'host');

update public.games set reserved_count = 0 where reserved_count > 0;
update public.games set capacity = public.side_max(game_type) * 2
 where capacity <> public.side_max(game_type) * 2;


-- ---------------------------------------------------------------------
-- ④ 정원·확보 인원을 받던 예전 등록·수정 함수 제거
-- ---------------------------------------------------------------------
drop function if exists public.create_game(text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text);
drop function if exists public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text);


-- ---------------------------------------------------------------------
-- ⑤ 목록 조회: 주최측·게스트측 인원과 한쪽 최대 인원 포함
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz,
  is_mine boolean, i_joined boolean, game_type text,
  host_count integer, guest_count integer, side_max integer
)
language sql stable security definer set search_path = public as $$
  select g.id, g.title, g.gym_name, g.region, g.game_at,
         g.duration_min, g.capacity, g.reserved_count,
         (select count(*)::integer from participants p where p.game_id = g.id),
         g.fee, g.level, g.description, g.contact,
         g.host_nickname, g.is_closed, g.created_at,
         coalesce(g.host_user_id = auth.uid(), false),
         exists (select 1 from participants p where p.game_id = g.id and p.user_id = auth.uid()),
         g.game_type,
         (select count(*)::integer from participants p where p.game_id = g.id and p.side = 'host'),
         (select count(*)::integer from participants p where p.game_id = g.id and p.side = 'guest'),
         side_max(g.game_type)
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑥ 참가자 명단: 어느 쪽인지(side) 포함
-- ---------------------------------------------------------------------
drop function if exists public.list_participants(bigint);
create function public.list_participants(p_game_id bigint)
returns table (id bigint, nickname text, pos text, created_at timestamptz, is_me boolean, side text)
language sql stable security definer set search_path = public as $$
  select p.id, p.nickname, p.pos, p.created_at,
         coalesce(p.user_id = auth.uid(), false),
         p.side
    from participants p
   where p.game_id = p_game_id
   order by p.created_at asc, p.id asc;
$$;


-- ---------------------------------------------------------------------
-- ⑦ 모집글 등록 (회원 전용)
--    정원은 게임 종류로 정해지고, 글쓴이는 주최측 첫 번째로 자동 등록
-- ---------------------------------------------------------------------
create or replace function public.create_game(
  p_game_type text,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_fee integer, p_level text, p_description text, p_contact text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := require_login();
  v_nick text := left(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'nickname'), ''), '회원'), 20);
  v_cap  integer;
  v_id   bigint;
begin
  if p_game_type is null or p_game_type not in ('5v5', '3v3') then
    raise exception '게임 종류 값이 올바르지 않습니다';
  end if;
  v_cap := side_max(p_game_type) * 2;
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        v_cap, 0, p_fee, p_level, p_description, p_contact);

  insert into games (game_type, title, gym_name, region, game_at, duration_min, capacity,
                     reserved_count, fee, level, description, contact,
                     host_nickname, host_user_id)
  values (p_game_type, trim(p_title), trim(p_gym_name), trim(coalesce(p_region, '')), p_game_at,
          p_duration_min, v_cap, 0, p_fee, p_level,
          trim(coalesce(p_description, '')), trim(coalesce(p_contact, '')),
          v_nick, v_uid)
  returning id into v_id;

  insert into participants (game_id, nickname, pos, side, user_id)
  values (v_id, v_nick, '무관', 'host', v_uid);

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑧ 모집글 수정 (글 주인만)
--    3:3 으로 바꿀 때 한쪽이 이미 3명을 넘으면 거부
-- ---------------------------------------------------------------------
create or replace function public.update_game(
  p_id bigint, p_game_type text,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_fee integer, p_level text, p_description text, p_contact text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_max   integer;
  v_host  integer;
  v_guest integer;
begin
  perform check_host(p_id);
  if p_game_type is null or p_game_type not in ('5v5', '3v3') then
    raise exception '게임 종류 값이 올바르지 않습니다';
  end if;
  v_max := side_max(p_game_type);
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        v_max * 2, 0, p_fee, p_level, p_description, p_contact);

  perform 1 from games where id = p_id for update;   -- 동시 신청과 겹치지 않게 잠금
  select count(*) filter (where side = 'host'), count(*) filter (where side = 'guest')
    into v_host, v_guest
    from participants where game_id = p_id;
  if v_host > v_max or v_guest > v_max then
    raise exception '한쪽 명단이 이미 %명을 넘어 이 게임 종류로 바꿀 수 없습니다. 먼저 명단을 줄여 주세요', v_max;
  end if;

  update games
     set game_type = p_game_type, capacity = v_max * 2,
         title = trim(p_title), gym_name = trim(p_gym_name),
         region = trim(coalesce(p_region, '')), game_at = p_game_at,
         duration_min = p_duration_min, fee = p_fee, level = p_level,
         description = trim(coalesce(p_description, '')),
         contact = trim(coalesce(p_contact, ''))
   where id = p_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑨ 참가 신청 (회원 전용) — 항상 게스트측으로 들어감
-- ---------------------------------------------------------------------
create or replace function public.join_game(p_game_id bigint, p_pos text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := require_login();
  v_nick  text := left(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'nickname'), ''), '회원'), 20);
  v_game  games%rowtype;
  v_guest integer;
  v_id    bigint;
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

  select count(*) into v_guest from participants where game_id = p_game_id and side = 'guest';
  if v_guest >= side_max(v_game.game_type) then
    raise exception '게스트측 자리가 모두 찼습니다';
  end if;

  insert into participants (game_id, nickname, pos, side, user_id)
  values (p_game_id, v_nick, p_pos, 'guest', v_uid)
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑩ 글 주인: 명단에 이름을 직접 추가 (주최측 또는 게스트측)
-- ---------------------------------------------------------------------
create or replace function public.add_participant(
  p_game_id bigint, p_side text, p_nickname text, p_pos text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_game  games%rowtype;
  v_count integer;
  v_id    bigint;
begin
  perform check_host(p_game_id);
  if p_side is null or p_side not in ('host', 'guest') then
    raise exception '주최측 또는 게스트측을 골라 주세요';
  end if;
  if char_length(trim(coalesce(p_nickname, ''))) not between 1 and 20 then
    raise exception '이름은 1자 이상 20자 이하로 입력해 주세요';
  end if;
  if p_pos is null or p_pos not in ('무관', '가드', '포워드', '센터') then
    raise exception '포지션 값이 올바르지 않습니다';
  end if;

  select * into v_game from games where id = p_game_id for update;   -- 동시 신청과 겹치지 않게 잠금
  select count(*) into v_count from participants where game_id = p_game_id and side = p_side;
  if v_count >= side_max(v_game.game_type) then
    raise exception '%은 최대 %명까지입니다',
      case when p_side = 'host' then '주최측' else '게스트측' end, side_max(v_game.game_type);
  end if;

  insert into participants (game_id, nickname, pos, side)
  values (p_game_id, trim(p_nickname), p_pos, p_side)
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑪ 권한
-- ---------------------------------------------------------------------
grant execute on function public.list_games()              to anon, authenticated;
grant execute on function public.list_participants(bigint) to anon, authenticated;

revoke execute on function public.side_max(text) from public, anon, authenticated;

revoke execute on function public.create_game(text,text,text,text,timestamptz,integer,integer,text,text,text)        from public, anon;
revoke execute on function public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,text,text,text) from public, anon;
revoke execute on function public.join_game(bigint,text)                  from public, anon;
revoke execute on function public.add_participant(bigint,text,text,text)  from public, anon;

grant execute on function public.create_game(text,text,text,text,timestamptz,integer,integer,text,text,text)        to authenticated;
grant execute on function public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,text,text,text) to authenticated;
grant execute on function public.join_game(bigint,text)                  to authenticated;
grant execute on function public.add_participant(bigint,text,text,text)  to authenticated;

-- 함수 목록이 바뀌었음을 API 서버에 알림
notify pgrst, 'reload schema';
