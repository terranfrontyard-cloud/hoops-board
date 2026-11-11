# 훕스보드

체육관을 대관한 사람이 5:5 농구 게임 인원을 모으는 게시판입니다.
순수 HTML/CSS/JS(설치·빌드 없음) + Supabase(데이터베이스, 회원 로그인)로 동작합니다.

## 기능

- **회원가입 / 로그인**: 이메일 + 비밀번호 + 닉네임 (Supabase Auth)
- **모집글 (회원 전용)**: 체육관, 지역, 일시, 정원(기본 10명), 이미 확보된 인원, 참가비, 실력 수준, 연락 수단
- **내 모집글 관리**: 글쓴 회원만 수정 / 모집 마감·재개 / 삭제 / 신청자 내보내기
- **참가 신청 (가입 불필요)**: 닉네임 + 포지션 + 비밀번호. 정원이 차면 자동으로 "모집 완료"
- **신청 취소**: 신청할 때 쓴 닉네임과 비밀번호
- 모집중·전체 필터, 지역·체육관 검색

## 시작하기

1. **예시 화면 보기**: 주소 끝에 `?demo`를 붙이면 저장되지 않는 예시 데이터로 볼 수 있습니다.
   아무 이메일로 가입·로그인해 볼 수 있고, 예시 참가자의 비밀번호는 `1234`입니다.
   (`js/config.js`가 비어 있으면 `?demo` 없이도 예시 모드로 열립니다.)
2. **Supabase SQL 실행**: Supabase → SQL Editor → 새 스니펫에 아래 파일을 **순서대로** 붙여 넣고 [Run]
   - `supabase/001_hoops_schema.sql`: 테이블, 보안(RLS), 함수
   - `supabase/002_auth_required.sql`: 모집글 쓰기를 회원 전용으로 변경
3. **연결 정보 입력**: `js/config.js`에 Project URL과 anon(publishable) 키를 넣습니다.
   - Supabase → Project Settings → API 에서 확인
   - `service_role`(secret) 키는 절대 넣지 마세요.
4. **회원가입 설정** (Supabase → Authentication)
   - **URL Configuration → Site URL**에 사이트 주소를 넣습니다. 인증 메일의 링크가 이 주소로 돌아옵니다.
   - 이메일 인증을 쓰지 않으려면 **Sign In / Providers → Email → Confirm email**을 끕니다. 끄면 가입 즉시 로그인됩니다.
   - Supabase 기본 메일 발송은 시간당 보낼 수 있는 수가 매우 적습니다. 가입자가 많아지면 인증을 끄거나 자체 SMTP를 연결하세요.

## 배포

정적 파일뿐이라 폴더를 그대로 올리면 됩니다. (Vercel, Netlify, GitHub Pages, Cloudflare Pages 등)
빌드 명령과 환경 변수 설정은 필요 없습니다.

## 파일 구조

```
hoops-board/
├─ index.html                        화면 뼈대
├─ css/style.css                     스타일 (모바일 우선, 다크 모드 지원)
├─ js/config.js                      Supabase URL / anon 키  ← 직접 입력
├─ js/api.js                         Supabase 함수 호출 + 로그인 + 예시 모드
├─ js/app.js                         목록·상세·폼·로그인 화면 동작
└─ supabase/
   ├─ 001_hoops_schema.sql           테이블, 보안(RLS), 함수
   └─ 002_auth_required.sql          모집글 쓰기를 회원 전용으로 변경
```

## 보안 구조

- 방문자는 `games`, `participants` 테이블에 **직접 접근할 수 없습니다** (RLS 켬 + 권한 회수).
- 모든 읽기/쓰기는 Supabase 함수(RPC)를 거칩니다.
- 모집글 등록·수정·삭제·마감·내보내기 함수는 **로그인한 회원만** 실행할 수 있고, 함수 안에서 글 주인인지 다시 검사합니다. 화면에서 버튼을 숨기는 것에 의존하지 않습니다.
- 회원 비밀번호는 Supabase Auth가 관리하며 이 앱의 테이블에는 저장되지 않습니다.
- 참가 신청 비밀번호는 bcrypt로 암호화되어 저장되고, 목록 함수는 해시와 회원 ID를 내보내지 않습니다.
- 참가 신청은 게임 행을 잠근 뒤 자리를 세므로 동시에 신청해도 정원을 넘지 않습니다.
- 연락 수단 칸은 **누구에게나 공개**됩니다. 전화번호보다 오픈채팅 링크를 권장합니다.
