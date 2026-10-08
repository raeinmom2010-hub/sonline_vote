# 학교 캐릭터 공모전 투표 사이트

학생들이 제출한 캐릭터 작품을 갤러리로 보여주고, 학생이 학교·학번·이름으로 로그인한 뒤
**하트(좋아요)** 와 **댓글**로 투표하는 사이트입니다. 교사는 `admin.html` 에서 작품 등록, 투표 시작/마감,
결과 CSV 내려받기를 합니다.

- 프론트: HTML + CSS + 바닐라 JS (빌드 도구 없음)
- 백엔드: Supabase (Database + Storage + Auth)
- 배포: GitHub Pages

```
📁 프로젝트
├─ index.html          학생용 투표 페이지
├─ admin.html          교사용 관리 페이지
├─ css/style.css       학생용 스타일
├─ css/admin.css       관리자 스타일
├─ js/config.js        ★ Supabase URL · anon key 입력 위치
├─ js/app.js           학생용 로직
├─ js/admin.js         관리자 로직
├─ supabase/schema.sql       ★ DB 테이블·보안 정책·함수·Storage 를 한 번에 만드는 SQL
├─ supabase/create_admin.sql 교사 계정을 SQL 로 미리 만드는 스크립트 (선택)
├─ 작품정보.csv         출품작 정보 양식 (관리자 → 작품 → CSV 불러오기)
└─ README.md
```

---

## 1. Supabase 설정 (처음 한 번)

### 1-1. 프로젝트 준비
1. https://supabase.com 에 로그인 → 프로젝트 `db_hyunuk` 을 엽니다. (없다면 **New project** 로 만듭니다. Region 은 `Northeast Asia (Seoul)` 권장)
2. 왼쪽 메뉴 **Project Settings → API** 에서 두 값을 확인합니다.
   - **Project URL** (예: `https://xxxx.supabase.co`)
   - **anon public** key (또는 `publishable` key)
3. `js/config.js` 를 열어 두 값이 들어 있는지 확인합니다. (이미 입력되어 있습니다.)

> ⚠️ `service_role` / `secret` key 는 절대로 코드에 넣지 마세요. GitHub Pages 는 코드가 전부 공개됩니다.
> anon key 는 공개되어도 괜찮도록 설계되어 있고, 데이터는 RLS(행 수준 보안)가 보호합니다.

### 1-2. 데이터베이스 만들기
1. 왼쪽 메뉴 **SQL Editor → New query**
2. `supabase/schema.sql` 파일 내용을 **전부** 복사해 붙여넣고 **Run** 을 누릅니다.
3. 결과창에 `schema ok` 가 보이면 성공입니다. (여러 번 실행해도 안전합니다.)

이 스크립트가 만드는 것:

| 종류 | 이름 | 설명 |
|---|---|---|
| 표 | `settings` | 투표 진행 여부, 사이트 제목, 안내문 |
| 표 | `secrets` | 관리자 가입 코드 (기본값 `sonline`). 클라이언트에서 읽을 수 없음 |
| 표 | `admins` | 교사(관리자) 이메일 목록 |
| 표 | `students` | 학생 프로필. (학교, 학번) 중복 불가 |
| 표 | `artworks` | 출품작 |
| 표 | `likes`, `comments` | 하트, 댓글 |
| 함수 | `claim_student`, `get_my_profile`, `get_my_likes`, `toggle_like`, `add_comment`, `delete_my_comment`, `logout_device` | 학생이 데이터를 다룰 수 있는 유일한 통로 (기기 토큰으로 본인 확인) |
| 함수 | `get_artwork_stats` | 작품별 하트·댓글 수 |
| 함수 | `is_admin`, `verify_admin_code`, `register_admin` | 관리자 판정·등록 |
| Storage | `artworks` 버킷 | 작품 이미지 (공개 읽기, 관리자만 업로드) |

### 1-3. 인증(Authentication) 설정
학생 로그인은 Supabase Auth 를 쓰지 않으므로(아래 "학생 로그인 방식" 참고) **익명 로그인 설정이나 Rate Limit 조정이 필요 없습니다.**
교사 로그인만 Supabase Auth 를 사용합니다. 왼쪽 메뉴 **Authentication** 에서:

1. **Sign In / Providers → Email** 이 켜져 있는지 확인합니다. (기본값: 켜짐)
2. (권장) **Sign In / Providers → Email → Confirm email** 을 **끕니다**.
   꺼 두면 교사 계정을 만들 때 가장 매끄럽습니다. 켜져 있어도 가입 코드로 등록할 때 자동으로 활성화되도록 만들어 두었습니다.

> **학생 로그인 방식**: 학생이 학교·학번·이름을 입력하면 DB 함수 `claim_student` 가 프로필을 확인하고
> 무작위 **기기 토큰**을 발급합니다. 브라우저는 토큰을 저장해 두고 하트·댓글을 보낼 때 함께 보냅니다.
> DB 에는 토큰의 해시만 저장되며, 같은 학생이 다른 기기에서 로그인하면 새 토큰이 발급되어 이전 기기는 투표할 수 없게 됩니다.

### 1-4. 교사(관리자) 계정 만들기 — 둘 중 하나
**방법 A. 관리 페이지에서 만들기 (권장)**
1. 사이트의 `admin.html` 을 엽니다. (로컬 테스트 또는 배포 후)
2. **관리자 계정 만들기** 탭 → 이메일, 비밀번호(6자 이상), 관리자 가입 코드(기본 `sonline`) 입력 → **계정 만들고 시작하기**
3. 계정 생성 → 활성화 → 관리자 등록이 한 번에 처리되고 바로 로그인됩니다.

**방법 B. SQL 로 미리 만들기**
1. SQL Editor 에 `supabase/create_admin.sql` 을 붙여넣습니다.
2. 위쪽의 `v_email`, `v_password` 두 줄을 바꿉니다. (비밀번호는 **SQL Editor 화면에서만** 바꾸고, 파일에 저장해 GitHub 에 올리지 마세요.)
3. Run. 결과창에 관리자 목록이 보이면 성공입니다.

### 1-5. 관리자 가입 코드 바꾸기 (권장)
기본 코드 `sonline` 은 이 README 에 적혀 있으므로, 운영 전에 바꾸세요. SQL Editor 에서:

```sql
update public.secrets set value = '새로운코드' where key = 'admin_signup_code';
```

---

## 2. 로컬 테스트

파일을 더블클릭(`file://`)해서 열면 일부 브라우저에서 동작하지 않습니다. 간단한 로컬 서버로 여세요.

**방법 1. Python 이 있을 때** (프로젝트 폴더에서)
```bash
python -m http.server 8080
```
→ 브라우저에서 http://localhost:8080 (학생), http://localhost:8080/admin.html (교사)

**방법 2. VS Code**
확장 **Live Server** 설치 → `index.html` 에서 오른쪽 클릭 → *Open with Live Server*

테스트 순서:
1. `admin.html` → 계정 만들기/로그인 → **작품** 탭에서 이미지 2~3장 올리기
2. **대시보드** 에서 투표 스위치 켜기
3. `index.html` → 로그인 → 하트, 댓글 눌러 보기
4. 같은 학교·학번으로 **다른 이름**으로 로그인하면 거부되는지 확인
5. 다른 브라우저(또는 시크릿 창)에서 같은 학생으로 로그인 → 원래 창에서 하트를 누르면 "다시 로그인" 안내가 뜨는지 확인
6. **대시보드** 에서 투표 끄기 → 학생 화면에서 하트가 "투표 마감" 문구로 바뀌는지 확인
7. **결과** 탭에서 CSV 3종 내려받아 엑셀로 열어 보기

---

## 3. GitHub Pages 배포

1. GitHub 에서 새 저장소를 만듭니다. (예: `sonline_vote`, **Public**)
2. 프로젝트 폴더에서:
   ```bash
   git init
   git add .
   git commit -m "캐릭터 공모전 투표 사이트"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```
3. 저장소 → **Settings → Pages** → *Build and deployment* 에서
   **Source: Deploy from a branch**, **Branch: main / (root)** → Save
4. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 로 접속됩니다.
   - 학생용: `https://<아이디>.github.io/<저장소>/`
   - 교사용: `https://<아이디>.github.io/<저장소>/admin.html`
5. 이후 파일을 고치면 `git add . && git commit -m "수정" && git push` 로 반영됩니다.

> 올리기 전 체크: `supabase/create_admin.sql` 에 실제 비밀번호가 남아 있지 않은지, `js/config.js` 에 anon key 만 있는지 확인하세요.

---

## 4. 운영 방법

### 작품 등록
1. `admin.html` → **작품** 탭
2. (선택) `작품정보.csv` 를 엑셀로 열어 제목·출품자·설명·파일명키워드를 채운 뒤 **CSV UTF-8** 로 저장 → **CSV 불러오기**
   - *파일명키워드*: 이미지 파일명에 들어 있는 글자. 예: 키워드가 `03` 이면 `캐릭터_03.png` 와 자동으로 짝지어집니다. `|` 로 여러 개를 적을 수 있습니다 (`03|홍길동`).
3. 이미지를 점선 상자에 끌어다 놓습니다. CSV 와 짝지어지지 않은 파일은 드롭다운에서 고르거나 직접 입력합니다.
4. **모두 업로드**. 올라간 작품은 아래 목록에서 바로 고칠 수 있습니다(수정 후 **저장**).
5. 투표 전에 잠시 감추고 싶으면 **숨김**, 완전히 지우려면 **삭제**(이미지 파일까지 삭제).

### 투표 시작 / 마감
**대시보드** 의 스위치 하나로 켜고 끕니다. 마감하면 학생 화면의 하트·댓글 버튼이 "투표 마감" 문구로 바뀌고,
DB 함수에서도 다시 검사하므로 화면을 조작해도 투표할 수 없습니다.

### 안내문
**대시보드 → 사이트 제목 · 안내문** 에서 수정하면 학생 화면 상단에 바로 반영됩니다. (학생이 화면을 다시 열 때)

### 학생 관리
- **학생** 탭: 로그인한 학생 목록, 검색, CSV
- **기기 연결 해제**: 학생이 "다른 기기에서 로그인되었다"고 하거나 공용 PC 에 세션이 남았을 때. 하트·댓글은 유지됩니다.
- **삭제**: 잘못 만든 프로필(이름 오타 등). 그 학생의 하트·댓글도 함께 지워집니다.

### 댓글 관리
**댓글** 탭에서 실제 이름·학번·작품과 함께 봅니다. 부적절한 댓글은 **숨김**(학생 화면에서만 사라짐) 또는 **삭제**.

### 결과
**결과** 탭의 순위표(동점은 같은 순위)와 CSV 3종(작품별 집계 / 하트 상세 / 댓글 상세).
CSV 는 UTF-8 BOM 이 들어 있어 엑셀에서 바로 열립니다.

### 교사 추가 / 해제
**교사 계정** 탭에서 이메일 + 임시 비밀번호 + 가입 코드로 추가합니다. 본인의 권한은 해제할 수 없습니다.

---

## 5. 문제 해결

| 증상 | 원인 · 해결 |
|---|---|
| 학생 화면에 "작품을 불러오지 못했어요" | `schema.sql` 을 아직 실행하지 않았거나 `config.js` 의 URL/key 가 틀림. 브라우저 F12 → Console 의 오류 메시지 확인 |
| 로그인 시 "로그인 중 문제가 생겼어요" | 네트워크 문제이거나 `schema.sql` 이 최신(v2, 기기 토큰 방식)이 아님. SQL Editor 에서 `schema.sql` 을 다시 실행 |
| 로그인 시 "Could not find the function public.claim_student" | 예전 버전 스키마가 들어 있음. `schema.sql` 전체를 다시 실행하면 v1 함수가 정리되고 v2 로 바뀜 |
| "같은 학교·학번으로 이미 다른 이름이 등록" | 학번 오타이거나 다른 학생이 그 학번을 먼저 씀. 교사가 **학생** 탭에서 확인 후 잘못된 프로필 삭제 |
| 학생이 "다른 기기에서 로그인되었다" 안내를 봄 | 정상 동작(마지막 로그인 기기만 투표 가능). 그 기기에서 다시 로그인하면 됨 |
| 교사 로그인 시 "Email not confirmed" | Confirm email 이 켜진 상태에서 코드 없이 가입한 경우. **관리자 계정 만들기** 탭에서 같은 이메일·비밀번호 + 가입 코드로 다시 등록하면 활성화됨 |
| 교사 로그인 후 "관리자로 등록되어 있지 않습니다" | `admins` 표에 이메일이 없음. 가입 코드로 등록하거나 SQL: `insert into public.admins(email, created_by) values ('이메일', 'sql');` |
| 이미지가 안 보임 | Storage 의 `artworks` 버킷이 public 인지 확인 (schema.sql 재실행하면 복구됨) |
| 업로드 실패 "new row violates row-level security" | 로그인한 계정이 관리자가 아님. 또는 세션 만료 → 로그아웃 후 다시 로그인 |
| 하트를 눌렀는데 되돌아감 | 투표가 마감되었거나 다른 기기에서 로그인됨. 화면의 안내 문구 확인 |

**모든 투표 데이터 초기화** (작품은 남기고 학생·하트·댓글만 삭제) — SQL Editor:
```sql
delete from public.students;   -- 하트·댓글은 함께 삭제됨
```

**작품까지 전부 초기화**:
```sql
delete from public.students;
delete from public.artworks;
-- Storage 의 이미지 파일은 대시보드 Storage → artworks 버킷에서 직접 비우기
```

---

## 6. 보안 설계 요약

- 코드에는 **anon key 만** 들어 있고, 모든 표에 RLS 가 켜져 있습니다.
- 학생은 테이블에 직접 쓸 수 없습니다. 로그인·하트·댓글은 `SECURITY DEFINER` 함수를 통해서만 가능하고,
  함수 안에서 **투표 기간, 본인 여부(기기 토큰), 글자 수, 이름 일치**를 다시 검사합니다.
- 학생 본인 확인은 Supabase Auth 대신 **기기 토큰**(무작위 UUID)으로 합니다. DB 에는 토큰의 해시만 저장되어
  교사가 표를 열어 봐도 학생을 사칭할 수 없고, 다른 기기에서 로그인하면 이전 토큰은 즉시 무효가 됩니다.
  (Supabase 익명 로그인의 IP 당 횟수 제한도 받지 않습니다.)
- 같은 (정규화한 학교명, 학번) 은 DB unique 인덱스로 1명만 허용됩니다. 학교명은 띄어쓰기와 "등학교/학교" 꼬리를 무시하고 비교합니다.
- 학생은 **자기 프로필과 자기 하트**만 조회할 수 있고, 다른 학생의 이름·학번은 어떤 경로로도 받을 수 없습니다.
  댓글 작성자명은 저장 시점에 마스킹(예: 강*욱)되어 실명 컬럼은 관리자만 봅니다.
- 관리자 판정은 `is_admin()` (admins 표의 이메일 일치 + 익명 계정이 아님). 관리자 등록은 가입 코드 검증 함수로만 가능하며,
  코드는 `secrets` 표에만 있고 클라이언트는 읽을 수 없습니다.
