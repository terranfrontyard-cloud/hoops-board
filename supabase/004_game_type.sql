-- =====================================================================
-- 004_game_type.sql
-- 훕스보드: 게시판을 풀코트 5:5 / 반코트 3:3 으로 구분
--
-- 사용법: 001, 002, 003 을 실행한 뒤,
--         Supabase → SQL Editor → 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다.
--
-- 바뀌는 점
--   1) 모집글에 게임 종류(game_type) 칸이 생깁니다: '5v5'(풀코트) 또는 '3v3'(반코트)
--   2) 이 파일 실행 전에 쓴 글은 모두 '5v5'(풀코트)로 분류됩니다.
--   3) 모집글 등록·수정 함수가 게임 종류를 함께 받습니다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 게임 종류 칸 추가 (기존 글은 5v5)
-- ---------------------------------------------------------------------
alter table public.games
  add column if not exists game_type text not null default '5v5';

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games add constraint games_game_type_check check (game_type in ('5v5', '3v3'));


-- ---------------------------------------------------------------------
-- ② 게임 종류를 받지 않던 예전 등록·수정 함수 제거
-- ---------------------------------------------------------------------
drop function if exists public.create_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text);
drop function if exists public.update_game(bigint,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text);


-- ---------------------------------------------------------------------
-- ③ 목록 조회: 게임 종류(game_type) 포함
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz,
  is_mine boolean, i_joined boolean, game_type text
)
language sql stable security definer set search_path = public as $$
  select g.id, g.title, g.gym_name, g.region, g.game_at,
         g.duration_min, g.capacity, g.reserved_count,
         (select count(*)::integer from participants p where p.game_id = g.id),
         g.fee, g.level, g.description, g.contact,
         g.host_nickname, g.is_closed, g.created_at,
         coalesce(g.host_user_id = auth.uid(), false),
         exists (select 1 from participants p where p.game_id = g.id and p.user_id = auth.uid()),
         g.game_type
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ④ 모집글 등록 (회원 전용) — 게임 종류 추가
-- ---------------------------------------------------------------------
create or replace function public.create_game(
  p_game_type text,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := require_login();
  v_nick text := left(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'nickname'), ''), '회원'), 20);
  v_id   bigint;
begin
  if p_game_type is null or p_game_type not in ('5v5', '3v3') then
    raise exception '게임 종류 값이 올바르지 않습니다';
  end if;
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        p_capacity, p_reserved_count, p_fee, p_level, p_description, p_contact);

  insert into games (game_type, title, gym_name, region, game_at, duration_min, capacity,
                     reserved_count, fee, level, description, contact,
                     host_nickname, host_user_id)
  values (p_game_type, trim(p_title), trim(p_gym_name), trim(coalesce(p_region, '')), p_game_at,
          p_duration_min, p_capacity, p_reserved_count, p_fee, p_level,
          trim(coalesce(p_description, '')), trim(coalesce(p_contact, '')),
          v_nick, v_uid)
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑤ 모집글 수정 (글 주인만) — 게임 종류 추가
-- ---------------------------------------------------------------------
create or replace function public.update_game(
  p_id bigint, p_game_type text,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_joined integer;
begin
  perform check_host(p_id);
  if p_game_type is null or p_game_type not in ('5v5', '3v3') then
    raise exception '게임 종류 값이 올바르지 않습니다';
  end if;
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        p_capacity, p_reserved_count, p_fee, p_level, p_description, p_contact);

  perform 1 from games where id = p_id for update;   -- 동시 신청과 겹치지 않게 잠금
  select count(*) into v_joined from participants where game_id = p_id;
  if p_reserved_count + v_joined > p_capacity then
    raise exception '이미 신청한 인원(%명)이 있어 정원을 그보다 줄일 수 없습니다', v_joined;
  end if;

  update games
     set game_type = p_game_type,
         title = trim(p_title), gym_name = trim(p_gym_name),
         region = trim(coalesce(p_region, '')), game_at = p_game_at,
         duration_min = p_duration_min, capacity = p_capacity,
         reserved_count = p_reserved_count, fee = p_fee, level = p_level,
         description = trim(coalesce(p_description, '')),
         contact = trim(coalesce(p_contact, ''))
   where id = p_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑥ 권한: 목록은 누구나, 등록·수정은 로그인한 회원만
-- ---------------------------------------------------------------------
grant execute on function public.list_games() to anon, authenticated;

revoke execute on function public.create_game(text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)        from public, anon;
revoke execute on function public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text) from public, anon;
grant  execute on function public.create_game(text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)        to authenticated;
grant  execute on function public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text) to authenticated;

-- 함수 목록이 바뀌었음을 API 서버에 알림
notify pgrst, 'reload schema';
