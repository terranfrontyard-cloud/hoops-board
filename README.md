# 훕스보드

체육관을 대관한 사람이 5:5 농구 게임 인원을 모으는 게시판입니다.
순수 HTML/CSS/JS(설치·빌드 없음) + Supabase(데이터베이스)로 동작합니다.

## 기능

- **모집글**: 체육관, 지역, 일시, 정원(기본 10명), 이미 확보된 인원, 참가비, 실력 수준, 연락 수단
- **참가 신청**: 닉네임 + 포지션 + 비밀번호. 정원이 차면 자동으로 "모집 완료"
- **신청 취소**: 신청할 때 쓴 닉네임과 비밀번호
- **주최자 관리**: 비밀번호로 수정 / 모집 마감·재개 / 삭제 / 신청자 내보내기
- 회원가입 없음. 모집중·전체 필터, 지역·체육관 검색

## 시작하기

1. **예시 화면 보기**: `index.html`을 브라우저로 열면 저장되지 않는 예시 데이터로 바로 볼 수 있습니다. (예시 글의 비밀번호는 `1234`)
2. **Supabase SQL 실행**: Supabase → SQL Editor → 새 스니펫에 `supabase/001_hoops_schema.sql` 전체를 붙여 넣고 [Run]
3. **연결 정보 입력**: `js/config.js`에 Project URL과 anon(publishable) 키를 넣습니다.
   - Supabase → Project Settings → API 에서 확인
   - `service_role`(secret) 키는 절대 넣지 마세요.
4. 새로고침하면 상단의 예시 안내가 사라지고 실제 게시판으로 동작합니다.

## 배포

정적 파일뿐이라 폴더를 그대로 올리면 됩니다. (Vercel, Netlify, GitHub Pages, Cloudflare Pages 등)
빌드 명령과 환경 변수 설정은 필요 없습니다.

## 파일 구조

```
hoops-board/
├─ index.html                     화면 뼈대
├─ css/style.css                  스타일 (모바일 우선, 다크 모드 지원)
├─ js/config.js                   Supabase URL / anon 키  ← 직접 입력
├─ js/api.js                      Supabase 함수 호출 + 예시 모드
├─ js/app.js                      목록·상세·폼 동작
└─ supabase/001_hoops_schema.sql  테이블, 보안(RLS), 함수
```

## 보안 구조

- 방문자는 `games`, `participants` 테이블에 **직접 접근할 수 없습니다** (RLS 켬 + 권한 회수).
- 모든 읽기/쓰기는 Supabase 함수(RPC)를 거치며, 함수 안에서 비밀번호와 정원을 검사합니다.
- 비밀번호는 bcrypt로 암호화되어 저장되고, 목록 함수는 해시를 내보내지 않습니다.
- 참가 신청은 게임 행을 잠근 뒤 자리를 세므로 동시에 신청해도 정원을 넘지 않습니다.
- 연락 수단 칸은 **누구에게나 공개**됩니다. 전화번호보다 오픈채팅 링크를 권장합니다.
