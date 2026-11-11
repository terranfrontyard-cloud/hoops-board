-- =====================================================================
-- 002_auth_required.sql
-- 훕스보드: 모집글 쓰기를 회원 전용으로 변경
--
-- 사용법: 001_hoops_schema.sql 을 실행한 뒤,
--         Supabase → SQL Editor → 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다.
--
-- 바뀌는 점
--   1) 모집글 등록·수정·삭제·마감·내보내기는 로그인한 회원만 할 수 있습니다.
--   2) 모집글의 주인은 비밀번호가 아니라 회원 계정(auth.uid())으로 구분합니다.
--   3) 목록 보기, 참가 신청·취소는 지금처럼 가입 없이 할 수 있습니다.
--   4) 이 파일을 실행하기 전에 비밀번호 방식으로 쓴 글은 주인이 없으므로
--      사이트에서 수정·삭제할 수 없습니다. (Supabase Table Editor에서 직접 지우면 됩니다)
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 모집글에 주인(회원) 칸 추가, 비밀번호 칸은 선택으로 변경
-- ---------------------------------------------------------------------
alter table public.games
  add column if not exists host_user_id uuid references auth.users (id) on delete cascade;
alter table public.games alter column host_pw_hash drop not null;

create index if not exists games_host_user_id_idx on public.games (host_user_id);


-- ---------------------------------------------------------------------
-- ② 비밀번호 방식의 예전 함수 제거 (같은 이름의 새 함수와 헷갈리지 않도록)
-- ---------------------------------------------------------------------
drop function if exists public.create_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text,text,text);
drop function if exists public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text);
drop function if exists public.delete_game(bigint,text);
drop function if exists public.set_game_closed(bigint,text,boolean);
drop function if exists public.kick_participant(bigint,text,bigint);
drop function if exists public.check_host(bigint,text);


-- ---------------------------------------------------------------------
-- ③ 내부 전용: 로그인 여부 / 글 주인 여부 확인
-- ---------------------------------------------------------------------
create or replace function public.require_login()
returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다';
  end if;
  return v_uid;
end; $$;

create or replace function public.check_host(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_login();
begin
  if not exists (select 1 from games where id = p_id and host_user_id = v_uid) then
    raise exception '내가 쓴 모집글만 관리할 수 있습니다';
  end if;
end; $$;

revoke execute on function public.require_login()    from public, anon, authenticated;
revoke execute on function public.check_host(bigint) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- ④ 목록 조회: 내 글인지(is_mine) 함께 알려 줌. 회원 ID는 내보내지 않음
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz, is_mine boolean
)
language sql stable security definer set search_path = public as $$
  select g.id, g.title, g.gym_name, g.region, g.game_at,
         g.duration_min, g.capacity, g.reserved_count,
         (select count(*)::integer from participants p where p.game_id = g.id),
         g.fee, g.level, g.description, g.contact,
         g.host_nickname, g.is_closed, g.created_at,
         coalesce(g.host_user_id = auth.uid(), false)
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑤ 모집글 등록 (회원 전용)
--    닉네임은 회원가입 때 적은 값을 사용
-- ---------------------------------------------------------------------
create or replace function public.create_game(
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
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        p_capacity, p_reserved_count, p_fee, p_level, p_description, p_contact);

  insert into games (title, gym_name, region, game_at, duration_min, capacity,
                     reserved_count, fee, level, description, contact,
                     host_nickname, host_user_id)
  values (trim(p_title), trim(p_gym_name), trim(coalesce(p_region, '')), p_game_at,
          p_duration_min, p_capacity, p_reserved_count, p_fee, p_level,
          trim(coalesce(p_description, '')), trim(coalesce(p_contact, '')),
          v_nick, v_uid)
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑥ 모집글 수정 (글 주인만)
-- ---------------------------------------------------------------------
create or replace function public.update_game(
  p_id bigint,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_joined integer;
begin
  perform check_host(p_id);
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        p_capacity, p_reserved_count, p_fee, p_level, p_description, p_contact);

  perform 1 from games where id = p_id for update;   -- 동시 신청과 겹치지 않게 잠금
  select count(*) into v_joined from participants where game_id = p_id;
  if p_reserved_count + v_joined > p_capacity then
    raise exception '이미 신청한 인원(%명)이 있어 정원을 그보다 줄일 수 없습니다', v_joined;
  end if;

  update games
     set title = trim(p_title), gym_name = trim(p_gym_name),
         region = trim(coalesce(p_region, '')), game_at = p_game_at,
         duration_min = p_duration_min, capacity = p_capacity,
         reserved_count = p_reserved_count, fee = p_fee, level = p_level,
         description = trim(coalesce(p_description, '')),
         contact = trim(coalesce(p_contact, ''))
   where id = p_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑦ 모집글 삭제 / 마감·재개 / 신청자 내보내기 (글 주인만)
-- ---------------------------------------------------------------------
create or replace function public.delete_game(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_host(p_id);
  delete from games where id = p_id;
end; $$;

create or replace function public.set_game_closed(p_id bigint, p_closed boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_host(p_id);
  update games set is_closed = coalesce(p_closed, true) where id = p_id;
end; $$;

create or replace function public.kick_participant(p_game_id bigint, p_participant_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_host(p_game_id);
  delete from participants where id = p_participant_id and game_id = p_game_id;
  if not found then
    raise exception '해당 신청자를 찾을 수 없습니다';
  end if;
end; $$;


-- ---------------------------------------------------------------------
-- ⑧ 권한: 목록은 누구나, 글 관리 함수는 로그인한 회원만
--    (참가 신청·취소 함수의 권한은 001에서 준 그대로 유지)
-- ---------------------------------------------------------------------
grant execute on function public.list_games() to anon, authenticated;

revoke execute on function public.create_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)        from public, anon;
revoke execute on function public.update_game(bigint,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text) from public, anon;
revoke execute on function public.delete_game(bigint)              from public, anon;
revoke execute on function public.set_game_closed(bigint,boolean)  from public, anon;
revoke execute on function public.kick_participant(bigint,bigint)  from public, anon;

grant execute on function public.create_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)        to authenticated;
grant execute on function public.update_game(bigint,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text) to authenticated;
grant execute on function public.delete_game(bigint)              to authenticated;
grant execute on function public.set_game_closed(bigint,boolean)  to authenticated;
grant execute on function public.kick_participant(bigint,bigint)  to authenticated;

-- 함수 목록이 바뀌었음을 API 서버에 알림
notify pgrst, 'reload schema';
