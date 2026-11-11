-- =====================================================================
-- 007_make_admin.sql
-- 훕스보드: 관리자 지정 / 해제 / 확인
--
-- 사용법: 관리자로 만들 사람이 먼저 사이트에서 회원가입을 해야 합니다.
--         그다음 Supabase → SQL Editor 에 필요한 부분만 붙여 넣고,
--         '여기에-이메일' 을 그 사람의 가입 이메일로 바꿔 [Run] 합니다.
--
-- ※ 이메일은 SQL Editor 안에서만 바꾸세요. 이 파일에 실제 이메일을 적어 저장하면
--    GitHub 공개 저장소에 그대로 올라갑니다.
-- ※ 지정·해제 후에는 그 사람이 사이트를 새로고침하면 바로 반영됩니다.
-- =====================================================================

-- ① 관리자로 지정
insert into public.admins (user_id)
select id from auth.users where email = '여기에-이메일'
on conflict (user_id) do nothing;

-- ② 지금 관리자 목록 확인
select u.email, a.created_at
  from public.admins a
  join auth.users u on u.id = a.user_id
 order by a.created_at;

-- ③ 관리자 해제 (필요할 때만 맨 앞의 -- 를 지우고 실행)
-- delete from public.admins
--  where user_id in (select id from auth.users where email = '여기에-이메일');
