-- =====================================================================
-- 001_hoops_schema.sql
-- 훕스보드 (농구 5:5 게임 모집 게시판): 테이블 + 보안(RLS) + RPC 함수
--
-- 사용법: Supabase → SQL Editor → [+] 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다. (if not exists / create or replace)
--
-- 보안 구조
--   1) 방문자(anon)는 테이블을 직접 읽거나 쓸 수 없습니다. (RLS + revoke)
--   2) 아래 함수(RPC)만 호출할 수 있고, 함수 안에서 비밀번호·정원을 검사합니다.
--   3) 비밀번호는 bcrypt(crypt + gen_salt('bf'))로 암호화해서 저장합니다.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- ① 모집글 테이블
-- ---------------------------------------------------------------------
create table if not exists public.games (
  id             bigint generated always as identity primary key,
  title          text        not null check (char_length(title) between 2 and 60),
  gym_name       text        not null check (char_length(gym_name) between 1 and 40),
  region         text        not null default '' check (char_length(region) <= 60),
  game_at        timestamptz not null,                                   -- 경기 시작 일시
  duration_min   integer     not null default 120 check (duration_min between 30 and 480),
  capacity       integer     not null default 10  check (capacity between 2 and 30),
  reserved_count integer     not null default 1   check (reserved_count >= 0), -- 주최자가 이미 확보한 인원
  fee            integer     not null default 0   check (fee between 0 and 1000000),
  level          text        not null default '무관'
                 check (level in ('무관', '초보', '중수', '고수')),
  description    text        not null default '' check (char_length(description) <= 1000),
  contact        text        not null default '' check (char_length(contact) <= 200),
  host_nickname  text        not null check (char_length(host_nickname) between 1 and 20),
  host_pw_hash   text        not null,
  is_closed      boolean     not null default false,                     -- 주최자가 수동 마감
  created_at     timestamptz not null default now(),
  check (reserved_count <= capacity)
);

-- ---------------------------------------------------------------------
-- ② 참가 신청 테이블 (한 경기에서 같은 닉네임은 한 번만)
-- ---------------------------------------------------------------------
create table if not exists public.participants (
  id         bigint generated always as identity primary key,
  game_id    bigint      not null references public.games (id) on delete cascade,
  nickname   text        not null check (char_length(nickname) between 1 and 20),
  pos        text        not null default '무관'
             check (pos in ('무관', '가드', '포워드', '센터')),
  pw_hash    text        not null,
  created_at timestamptz not null default now(),
  unique (game_id, nickname)
);

create index if not exists games_game_at_idx on public.games (game_at);


-- ---------------------------------------------------------------------
-- ③ 방문자의 직접 접근 차단 (정책을 만들지 않으므로 함수로만 접근 가능)
-- ---------------------------------------------------------------------
alter table public.games        enable row level security;
alter table public.participants enable row level security;
revoke all on public.games        from anon, authenticated;
revoke all on public.participants from anon, authenticated;


-- ---------------------------------------------------------------------
-- ④ 내부 전용: 주최자 비밀번호 확인
-- ---------------------------------------------------------------------
create or replace function public.check_host(p_id bigint, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from games
     where id = p_id and host_pw_hash = crypt(coalesce(p_password, ''), host_pw_hash)
  ) then
    raise exception '모집글이 없거나 주최자 비밀번호가 틀렸습니다';
  end if;
end; $$;

-- ---------------------------------------------------------------------
-- ⑤ 내부 전용: 모집글 입력값 검사 (등록·수정 공통)
-- ---------------------------------------------------------------------
create or replace function public.validate_game(
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text)
returns void
language plpgsql set search_path = public as $$
begin
  if char_length(trim(coalesce(p_title, ''))) not between 2 and 60 then
    raise exception '제목은 2자 이상 60자 이하로 입력해 주세요';
  end if;
  if char_length(trim(coalesce(p_gym_name, ''))) not between 1 and 40 then
    raise exception '체육관 이름은 1자 이상 40자 이하로 입력해 주세요';
  end if;
  if char_length(trim(coalesce(p_region, ''))) > 60 then
    raise exception '지역은 60자 이하로 입력해 주세요';
  end if;
  if p_game_at is null or p_game_at <= now() then
    raise exception '경기 일시는 지금 이후로 정해 주세요';
  end if;
  if p_duration_min is null or p_duration_min not between 30 and 480 then
    raise exception '진행 시간은 30분 이상 8시간 이하로 정해 주세요';
  end if;
  if p_capacity is null or p_capacity not between 2 and 30 then
    raise exception '정원은 2명 이상 30명 이하로 정해 주세요';
  end if;
  if p_reserved_count is null or p_reserved_count not between 0 and p_capacity then
    raise exception '확보된 인원은 0명 이상, 정원 이하로 입력해 주세요';
  end if;
  if p_fee is null or p_fee not between 0 and 1000000 then
    raise exception '참가비는 0원 이상 100만원 이하로 입력해 주세요';
  end if;
  if p_level is null or p_level not in ('무관', '초보', '중수', '고수') then
    raise exception '실력 수준 값이 올바르지 않습니다';
  end if;
  if char_length(coalesce(p_description, '')) > 1000 then
    raise exception '설명은 1000자 이하로 입력해 주세요';
  end if;
  if char_length(trim(coalesce(p_contact, ''))) > 200 then
    raise exception '연락 수단은 200자 이하로 입력해 주세요';
  end if;
end; $$;

revoke execute on function public.check_host(bigint, text) from public, anon, authenticated;
revoke execute on function public.validate_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- ⑥ 목록 조회: 비밀번호 해시는 내보내지 않음. 30일 지난 경기는 제외
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.title, g.gym_name, g.region, g.game_at,
         g.duration_min, g.capacity, g.reserved_count,
         (select count(*)::integer from participants p where p.game_id = g.id),
         g.fee, g.level, g.description, g.contact,
         g.host_nickname, g.is_closed, g.created_at
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑦ 참가자 명단
-- ---------------------------------------------------------------------
drop function if exists public.list_participants(bigint);
create function public.list_participants(p_game_id bigint)
returns table (id bigint, nickname text, pos text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.nickname, p.pos, p.created_at
    from participants p
   where p.game_id = p_game_id
   order by p.created_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑧ 모집글 등록
-- ---------------------------------------------------------------------
create or replace function public.create_game(
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text,
  p_nickname text, p_password text)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id bigint;
begin
  perform validate_game(p_title, p_gym_name, p_region, p_game_at, p_duration_min,
                        p_capacity, p_reserved_count, p_fee, p_level, p_description, p_contact);
  if char_length(trim(coalesce(p_nickname, ''))) not between 1 and 20 then
    raise exception '닉네임은 1자 이상 20자 이하로 입력해 주세요';
  end if;
  if coalesce(length(p_password), 0) < 4 then
    raise exception '비밀번호는 4자 이상이어야 합니다';
  end if;

  insert into games (title, gym_name, region, game_at, duration_min, capacity,
                     reserved_count, fee, level, description, contact,
                     host_nickname, host_pw_hash)
  values (trim(p_title), trim(p_gym_name), trim(coalesce(p_region, '')), p_game_at,
          p_duration_min, p_capacity, p_reserved_count, p_fee, p_level,
          trim(coalesce(p_description, '')), trim(coalesce(p_contact, '')),
          trim(p_nickname), crypt(p_password, gen_salt('bf')))
  returning id into v_id;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑨ 모집글 수정 (주최자 비밀번호 필요)
--    이미 신청한 사람 수보다 정원을 줄일 수는 없음
-- ---------------------------------------------------------------------
create or replace function public.update_game(
  p_id bigint, p_password text,
  p_title text, p_gym_name text, p_region text, p_game_at timestamptz,
  p_duration_min integer, p_capacity integer, p_reserved_count integer,
  p_fee integer, p_level text, p_description text, p_contact text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_joined integer;
begin
  perform check_host(p_id, p_password);
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
-- ⑩ 모집글 삭제 / 수동 마감·재개 (주최자 비밀번호 필요)
-- ---------------------------------------------------------------------
create or replace function public.delete_game(p_id bigint, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform check_host(p_id, p_password);
  delete from games where id = p_id;   -- 참가 신청도 함께 삭제됨 (on delete cascade)
end; $$;

create or replace function public.set_game_closed(p_id bigint, p_password text, p_closed boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform check_host(p_id, p_password);
  update games set is_closed = coalesce(p_closed, true) where id = p_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑪ 참가 신청
--    게임 행을 잠근 뒤 자리를 세기 때문에 동시에 눌러도 정원을 넘지 않음
-- ---------------------------------------------------------------------
create or replace function public.join_game(
  p_game_id bigint, p_nickname text, p_pos text, p_password text)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_game   games%rowtype;
  v_joined integer;
  v_id     bigint;
begin
  if char_length(trim(coalesce(p_nickname, ''))) not between 1 and 20 then
    raise exception '닉네임은 1자 이상 20자 이하로 입력해 주세요';
  end if;
  if p_pos is null or p_pos not in ('무관', '가드', '포워드', '센터') then
    raise exception '포지션 값이 올바르지 않습니다';
  end if;
  if coalesce(length(p_password), 0) < 4 then
    raise exception '비밀번호는 4자 이상이어야 합니다';
  end if;

  select * into v_game from games where id = p_game_id for update;
  if not found then
    raise exception '모집글을 찾을 수 없습니다';
  end if;
  if v_game.is_closed then
    raise exception '주최자가 모집을 마감했습니다';
  end if;
  if v_game.game_at <= now() then
    raise exception '이미 시작했거나 끝난 경기입니다';
  end if;

  select count(*) into v_joined from participants where game_id = p_game_id;
  if v_game.reserved_count + v_joined >= v_game.capacity then
    raise exception '정원이 모두 찼습니다';
  end if;

  begin
    insert into participants (game_id, nickname, pos, pw_hash)
    values (p_game_id, trim(p_nickname), p_pos, crypt(p_password, gen_salt('bf')))
    returning id into v_id;
  exception when unique_violation then
    raise exception '이 경기에 같은 닉네임으로 이미 신청했습니다';
  end;

  return v_id;
end; $$;


-- ---------------------------------------------------------------------
-- ⑫ 참가 취소 (신청할 때 쓴 닉네임 + 비밀번호)
-- ---------------------------------------------------------------------
create or replace function public.leave_game(p_game_id bigint, p_nickname text, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from participants
   where game_id = p_game_id and nickname = trim(coalesce(p_nickname, ''))
     and pw_hash = crypt(coalesce(p_password, ''), pw_hash);
  if not found then
    raise exception '신청 내역이 없거나 비밀번호가 틀렸습니다';
  end if;
end; $$;


-- ---------------------------------------------------------------------
-- ⑬ 주최자: 신청자 내보내기
-- ---------------------------------------------------------------------
create or replace function public.kick_participant(
  p_game_id bigint, p_password text, p_participant_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform check_host(p_game_id, p_password);
  delete from participants where id = p_participant_id and game_id = p_game_id;
  if not found then
    raise exception '해당 신청자를 찾을 수 없습니다';
  end if;
end; $$;


-- ---------------------------------------------------------------------
-- ⑭ 방문자에게 함수 창구 이용 허락
-- ---------------------------------------------------------------------
grant execute on function public.list_games()                                   to anon, authenticated;
grant execute on function public.list_participants(bigint)                      to anon, authenticated;
grant execute on function public.create_game(text,text,text,timestamptz,integer,integer,integer,integer,text,text,text,text,text)
                                                                                to anon, authenticated;
grant execute on function public.update_game(bigint,text,text,text,text,timestamptz,integer,integer,integer,integer,text,text,text)
                                                                                to anon, authenticated;
grant execute on function public.delete_game(bigint,text)                       to anon, authenticated;
grant execute on function public.set_game_closed(bigint,text,boolean)           to anon, authenticated;
grant execute on function public.join_game(bigint,text,text,text)               to anon, authenticated;
grant execute on function public.leave_game(bigint,text,text)                   to anon, authenticated;
grant execute on function public.kick_participant(bigint,text,bigint)           to anon, authenticated;
