-- =====================================================================
-- 006_admin_role.sql
-- 훕스보드: 관리자 권한 추가 (일반 회원과 권한 분리)
--
-- 사용법: 001 ~ 005 를 실행한 뒤,
--         Supabase → SQL Editor → 새 스니펫 → 이 파일 전체 붙여넣기 → [Run]
-- 여러 번 실행해도 안전합니다.
-- 관리자를 지정하는 방법은 007_make_admin.sql 을 보세요.
--
-- 권한 정리
--   비회원      : 목록·명단 보기
--   일반 회원   : 모집글 쓰기, 참가 신청·취소, "내가 쓴 글"만 수정·마감·삭제·명단 관리
--   관리자      : 일반 회원의 모든 것 + "모든 글"의 수정·마감·삭제·명단 관리
--
-- 관리자 여부는 admins 테이블에 들어 있는지로 판단하며, 서버 함수 안에서 검사합니다.
-- 화면에서 버튼을 숨기는 것에 의존하지 않습니다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① 관리자 목록 테이블 (방문자·회원은 직접 읽거나 쓸 수 없음)
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;


-- ---------------------------------------------------------------------
-- ② 지금 로그인한 사람이 관리자인지 (로그인하지 않았으면 false)
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;


-- ---------------------------------------------------------------------
-- ③ 글 관리 권한 검사: 글 주인이거나 관리자면 통과
--    수정·삭제·마감·명단 추가·명단에서 빼기 함수가 모두 이 검사를 거침
-- ---------------------------------------------------------------------
create or replace function public.check_host(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := require_login();
begin
  if not exists (select 1 from games where id = p_id) then
    raise exception '모집글을 찾을 수 없습니다';
  end if;
  if is_admin() then
    return;
  end if;
  if not exists (select 1 from games where id = p_id and host_user_id = v_uid) then
    raise exception '내가 쓴 모집글만 관리할 수 있습니다';
  end if;
end; $$;

revoke execute on function public.check_host(bigint) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- ④ 목록 조회: 내가 관리할 수 있는 글인지(can_manage) 포함
-- ---------------------------------------------------------------------
drop function if exists public.list_games();
create function public.list_games()
returns table (
  id bigint, title text, gym_name text, region text, game_at timestamptz,
  duration_min integer, capacity integer, reserved_count integer, joined_count integer,
  fee integer, level text, description text, contact text,
  host_nickname text, is_closed boolean, created_at timestamptz,
  is_mine boolean, i_joined boolean, game_type text,
  host_count integer, guest_count integer, side_max integer,
  can_manage boolean
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
         side_max(g.game_type),
         coalesce(g.host_user_id = auth.uid(), false) or is_admin()
    from games g
   where g.game_at > now() - interval '30 days'
   order by g.game_at asc;
$$;


-- ---------------------------------------------------------------------
-- ⑤ 권한
-- ---------------------------------------------------------------------
grant execute on function public.list_games() to anon, authenticated;
grant execute on function public.is_admin()   to anon, authenticated;

-- 함수 목록이 바뀌었음을 API 서버에 알림
notify pgrst, 'reload schema';
