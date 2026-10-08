-- =====================================================================
--  학교 캐릭터 공모전 투표 사이트 - Supabase 스키마 (v2: 기기 토큰 방식)
-- =====================================================================
--  사용 방법
--    Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run
--
--  특징
--    * 여러 번 실행해도 안전합니다. (if not exists / or replace / drop ... if exists)
--    * 학생은 Supabase Auth(익명 로그인)를 쓰지 않습니다. 대신:
--        - claim_student() 가 학생을 확인하고 "기기 토큰"(무작위 uuid)을 발급
--        - 브라우저는 토큰을 localStorage 에 보관하고, 하트·댓글 함수를 부를 때 함께 보냄
--        - DB 에는 토큰의 해시(md5)만 저장 → 교사가 표를 열어 봐도 학생 토큰을 알 수 없음
--        - 다른 기기에서 다시 로그인하면 새 토큰이 발급되고 이전 토큰은 무효
--    * 학생의 "쓰기"(로그인·하트·댓글)는 전부 SECURITY DEFINER 함수를 통해서만 가능하고,
--      테이블에 직접 insert/update/delete 하는 정책은 학생에게 없습니다.
--    * 교사(관리자)는 Supabase 이메일 로그인 + is_admin() 이 true 일 때만 테이블을 직접 다룹니다.
--
--  용어
--    anon           : 로그인하지 않은 방문자 역할. 학생 화면은 항상 이 역할로 동작함
--    authenticated  : Supabase Auth 로 로그인한 사용자(교사)
--    SECURITY DEFINER : 함수를 "만든 사람(postgres)" 권한으로 실행. RLS 를 우회해서
--                       필요한 검사만 한 뒤 안전하게 데이터를 바꿀 때 사용
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 공용 유틸 함수
-- ---------------------------------------------------------------------

-- 학교 이름 정규화
--   "서울 고등학교", "서울고등학교", "서울고" → 모두 "서울고"
--   "한빛중학교", "한빛중" → "한빛중"
--   규칙: 소문자화 → 모든 공백 제거 → 끝에 붙은 "등학교" 또는 "학교" 제거
create or replace function public.normalize_school(p_school text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           regexp_replace(lower(coalesce(p_school, '')), '\s+', '', 'g'),
           '(등학교|학교)$',
           ''
         );
$$;

-- 이름 마스킹: "강현욱" → "강*욱", "김민" → "김*", "남궁민수" → "남**수"
--   댓글을 저장하는 순간 마스킹한 이름을 함께 저장하므로,
--   실제 이름이 다른 학생에게 전달되는 경로 자체가 없습니다.
create or replace function public.mask_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');
  v_len  int  := char_length(v_name);
begin
  if v_len <= 1 then
    return '*';
  elsif v_len = 2 then
    return left(v_name, 1) || '*';
  else
    return left(v_name, 1) || repeat('*', v_len - 2) || right(v_name, 1);
  end if;
end;
$$;

-- 기기 토큰 → 저장용 해시 (DB 에는 해시만 저장)
create or replace function public.token_hash(p_token uuid)
returns text
language sql
immutable
as $$
  select md5(coalesce(p_token::text, ''));
$$;


-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 1-1. 관리자(교사) 목록
create table if not exists public.admins (
  email       text primary key,
  created_at  timestamptz not null default now(),
  created_by  text                                   -- 누가 추가했는지(이메일 또는 'sql', 'signup-code')
);

-- 1-2. 사이트 설정 (행이 딱 1개만 존재)
create table if not exists public.settings (
  id           int primary key default 1 check (id = 1),
  voting_open  boolean not null default false,              -- true 면 투표 진행 중
  site_title   text not null default '캐릭터 공모전 투표',
  site_notice  text not null default '마음에 드는 작품에 하트를 눌러 주세요. 작품마다 1번씩 누를 수 있어요.',
  updated_at   timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- 1-3. 비밀 값 저장소 (관리자 가입 코드 등)
--   RLS 를 켜고 정책을 하나도 만들지 않아서 anon/authenticated 는 절대 읽을 수 없습니다.
create table if not exists public.secrets (
  key    text primary key,
  value  text not null
);
insert into public.secrets (key, value)
values ('admin_signup_code', 'sonline')          -- 기본 가입 코드. 운영 전에 바꾸는 것을 권장합니다.
on conflict (key) do nothing;

-- 1-4. 학생 프로필
--   * 같은 (정규화한 학교, 학번) 은 1명만 존재 → unique 인덱스로 보장
--   * device_hash : 현재 이 학생과 연결된 기기 토큰의 해시. 다른 기기에서 다시 로그인하면
--                   새 값으로 바뀌고, 이전 기기는 더 이상 투표할 수 없게 됩니다. null 이면 연결 해제 상태.
create table if not exists public.students (
  id             uuid primary key default gen_random_uuid(),
  school         text not null,                                                   -- 입력한 그대로의 학교명
  school_key     text generated always as (public.normalize_school(school)) stored, -- 비교용 정규화 학교명
  student_no     text not null,
  name           text not null,
  device_hash    text unique,
  consented_at   timestamptz,                                                     -- 개인정보 동의 시각
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);
-- (v1 에서 올라온 경우) 익명 로그인용 컬럼 제거, 토큰 컬럼 추가
--   auth_uid 를 참조하던 v1 정책을 먼저 지워야 컬럼을 지울 수 있음
drop policy if exists "students_select_own_or_admin" on public.students;
drop policy if exists "likes_select_own_or_admin"    on public.likes;
drop function if exists public.current_student_id();
alter table public.students drop column if exists auth_uid;
alter table public.students add column if not exists device_hash text unique;
create unique index if not exists students_school_no_uidx on public.students (school_key, student_no);

-- 1-5. 출품작
create table if not exists public.artworks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  author       text not null default '',          -- 출품자(학생 이름 등). 갤러리에 그대로 표시됨
  description  text not null default '',          -- 작품 설명 전문
  image_path   text not null,                     -- Storage(artworks 버킷) 안의 파일 경로
  sort_order   int  not null default 0,
  hidden       boolean not null default false,    -- true 면 학생 갤러리에서 숨김
  created_at   timestamptz not null default now()
);

-- 1-6. 하트(좋아요)  : 작품당 학생 1명이 1번
create table if not exists public.likes (
  id          uuid primary key default gen_random_uuid(),
  artwork_id  uuid not null references public.artworks (id) on delete cascade,
  student_id  uuid not null references public.students (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (artwork_id, student_id)
);
create index if not exists likes_artwork_idx on public.likes (artwork_id);
create index if not exists likes_student_idx on public.likes (student_id);

-- 1-7. 댓글
create table if not exists public.comments (
  id           uuid primary key default gen_random_uuid(),
  artwork_id   uuid not null references public.artworks (id) on delete cascade,
  student_id   uuid not null references public.students (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 200),
  masked_name  text not null,                     -- 저장 시점에 마스킹한 작성자명 (예: 강*욱)
  hidden       boolean not null default false,    -- 교사가 숨긴 댓글
  created_at   timestamptz not null default now()
);
create index if not exists comments_artwork_idx on public.comments (artwork_id);
create index if not exists comments_student_idx on public.comments (student_id);


-- ---------------------------------------------------------------------
-- 2. 권한 판정 함수
-- ---------------------------------------------------------------------

-- 관리자 여부
--   조건 1) 익명 로그인 계정이 아니어야 함 (JWT 의 is_anonymous 가 true 가 아님)
--   조건 2) JWT 의 이메일이 admins 표에 있어야 함
--   SECURITY DEFINER 인 이유: admins 표의 RLS 정책이 다시 is_admin() 을 부르면 무한 재귀가 되므로,
--   이 함수는 RLS 를 우회해서 admins 를 읽습니다.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true'
     and auth.email() is not null
     and exists (
       select 1 from public.admins a
       where lower(a.email) = lower(auth.email())
     );
$$;

-- 기기 토큰으로 학생 id 찾기 (함수 내부용. 클라이언트에는 실행 권한을 주지 않음)
create or replace function public.student_id_by_token(p_token uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.students s
   where p_token is not null and s.device_hash = public.token_hash(p_token)
   limit 1;
$$;


-- ---------------------------------------------------------------------
-- 3. RLS(행 수준 보안) 켜기 + 정책
--    정책은 "drop if exists → create" 순서로 적어서 재실행에 안전하게 합니다.
-- ---------------------------------------------------------------------
alter table public.admins    enable row level security;
alter table public.settings  enable row level security;
alter table public.secrets   enable row level security;
alter table public.students  enable row level security;
alter table public.artworks  enable row level security;
alter table public.likes     enable row level security;
alter table public.comments  enable row level security;

-- secrets: 정책 없음 + 권한 자체를 회수 (이중 안전장치)
revoke all on table public.secrets from anon, authenticated;

-- admins: 관리자만 목록 조회, 관리자는 "본인이 아닌" 관리자를 해제(삭제) 가능. 추가는 함수로만.
drop policy if exists "admins_select_admin" on public.admins;
create policy "admins_select_admin" on public.admins
  for select to authenticated
  using (public.is_admin());

drop policy if exists "admins_delete_admin" on public.admins;
create policy "admins_delete_admin" on public.admins
  for delete to authenticated
  using (public.is_admin() and lower(email) <> lower(auth.email()));

-- settings: 누구나 읽기, 관리자만 수정
drop policy if exists "settings_select_all" on public.settings;
create policy "settings_select_all" on public.settings
  for select to anon, authenticated
  using (true);

drop policy if exists "settings_update_admin" on public.settings;
create policy "settings_update_admin" on public.settings
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- students: 관리자만 조회 / 수정(기기 연결 해제) / 삭제. 학생은 함수(get_my_profile)로 자기 정보만 받음.
drop policy if exists "students_select_admin" on public.students;
create policy "students_select_admin" on public.students
  for select to authenticated
  using (public.is_admin());

drop policy if exists "students_update_admin" on public.students;
create policy "students_update_admin" on public.students
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "students_delete_admin" on public.students;
create policy "students_delete_admin" on public.students
  for delete to authenticated
  using (public.is_admin());

-- artworks: 숨기지 않은 작품은 누구나(로그인 전 포함) 조회, 관리자는 전부 + 쓰기
drop policy if exists "artworks_select_visible_or_admin" on public.artworks;
create policy "artworks_select_visible_or_admin" on public.artworks
  for select to anon, authenticated
  using (hidden = false or public.is_admin());

drop policy if exists "artworks_insert_admin" on public.artworks;
create policy "artworks_insert_admin" on public.artworks
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "artworks_update_admin" on public.artworks;
create policy "artworks_update_admin" on public.artworks
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "artworks_delete_admin" on public.artworks;
create policy "artworks_delete_admin" on public.artworks
  for delete to authenticated
  using (public.is_admin());

-- likes: 관리자만 직접 조회/삭제. 학생은 toggle_like()/get_my_likes() 함수로만. 전체 개수는 get_artwork_stats().
drop policy if exists "likes_select_admin" on public.likes;
create policy "likes_select_admin" on public.likes
  for select to authenticated
  using (public.is_admin());

drop policy if exists "likes_delete_admin" on public.likes;
create policy "likes_delete_admin" on public.likes
  for delete to authenticated
  using (public.is_admin());

-- comments: 숨기지 않은 댓글은 누구나 조회(마스킹된 이름만 들어 있음), 관리자는 전부 + 숨김/삭제.
--           학생의 작성/본인 삭제는 add_comment() / delete_my_comment() 함수로만 가능.
drop policy if exists "comments_select_visible_or_admin" on public.comments;
create policy "comments_select_visible_or_admin" on public.comments
  for select to anon, authenticated
  using (hidden = false or public.is_admin());

drop policy if exists "comments_update_admin" on public.comments;
create policy "comments_update_admin" on public.comments
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "comments_delete_admin" on public.comments;
create policy "comments_delete_admin" on public.comments
  for delete to authenticated
  using (public.is_admin());


-- ---------------------------------------------------------------------
-- 4. 학생용 함수 (모두 SECURITY DEFINER, 첫 인자는 기기 토큰)
--    클라이언트(js/app.js)는 supabase.rpc('함수명', {인자}) 로 호출합니다.
--    오류 메시지는 한국어로 raise 하고, 프로그램이 구분해야 하는 경우 hint 에 코드를 넣습니다.
-- ---------------------------------------------------------------------

-- v1 함수(익명 로그인 기반) 시그니처 제거
drop function if exists public.claim_student(text, text, text, boolean);
drop function if exists public.toggle_like(uuid);
drop function if exists public.add_comment(uuid, text);
drop function if exists public.delete_my_comment(uuid);

-- 4-1. 학생 로그인(프로필 연결) → 기기 토큰 발급
--   * (학교, 학번) 이 처음이면 프로필 생성
--   * 이미 있으면 이름이 같을 때만 "이 기기"로 연결을 옮김 (학번 도용 방지)
--   * 반환: {id, school, student_no, name, token}  ← token 은 이 응답에서만 볼 수 있음
create or replace function public.claim_student(
  p_school      text,
  p_student_no  text,
  p_name        text,
  p_consent     boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school  text := regexp_replace(trim(coalesce(p_school, '')), '\s+', ' ', 'g');   -- 연속 공백은 1개로
  v_no      text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');     -- 학번은 공백 전부 제거
  v_name    text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');           -- 이름도 공백 제거
  v_key     text := public.normalize_school(v_school);
  v_token   uuid := gen_random_uuid();                                              -- 새 기기 토큰
  s         public.students%rowtype;
begin
  if not coalesce(p_consent, false) then
    raise exception '개인정보 수집·이용에 동의해야 참여할 수 있습니다.' using hint = 'NO_CONSENT';
  end if;
  if v_key = '' or v_no = '' or v_name = '' then
    raise exception '학교, 학번, 이름을 모두 입력해 주세요.' using hint = 'EMPTY';
  end if;
  if char_length(v_school) > 30 or char_length(v_no) > 20 or char_length(v_name) > 20 then
    raise exception '입력이 너무 깁니다. (학교 30자, 학번·이름 20자 이내)' using hint = 'TOO_LONG';
  end if;

  select * into s
    from public.students
   where school_key = v_key and student_no = v_no
   for update;

  if not found then
    -- 처음 참여하는 학생 → 프로필 생성
    begin
      insert into public.students (school, student_no, name, device_hash, consented_at, last_login_at)
      values (v_school, v_no, v_name, public.token_hash(v_token), now(), now())
      returning * into s;
    exception when unique_violation then
      -- 두 기기에서 동시에 처음 로그인한 아주 드문 경우
      raise exception '잠시 후 다시 시도해 주세요.' using hint = 'RETRY';
    end;
  else
    -- 이미 있는 학생 → 이름이 같아야만 연결을 넘겨줌
    if regexp_replace(s.name, '\s+', '', 'g') <> v_name then
      raise exception '같은 학교·학번으로 이미 다른 이름이 등록되어 있습니다. 학번을 다시 확인해 주세요.'
        using hint = 'NAME_MISMATCH';
    end if;
    update public.students
       set device_hash   = public.token_hash(v_token),   -- 새 기기로 연결 이동 (이전 기기는 투표 불가)
           last_login_at = now(),
           consented_at  = coalesce(consented_at, now())
     where id = s.id
     returning * into s;
  end if;

  return jsonb_build_object(
    'id',         s.id,
    'school',     s.school,
    'student_no', s.student_no,
    'name',       s.name,
    'token',      v_token
  );
end;
$$;

-- 4-2. 토큰으로 내 프로필 확인 (페이지를 다시 열었을 때 로그인 상태 복원용)
--   연결이 끊겼으면(다른 기기 로그인, 교사가 해제) null 을 돌려줌
create or replace function public.get_my_profile(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', s.id, 'school', s.school, 'student_no', s.student_no, 'name', s.name)
    from public.students s
   where s.id = public.student_id_by_token(p_token);
$$;

-- 4-3. 내가 하트를 누른 작품 id 목록
create or replace function public.get_my_likes(p_token uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.artwork_id from public.likes l
   where l.student_id = public.student_id_by_token(p_token);
$$;

-- 4-4. 하트 토글 (누르면 추가, 다시 누르면 취소)
--   반환: {"liked": true/false, "count": 현재 하트 수}
create or replace function public.toggle_like(p_token uuid, p_artwork_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid    uuid := public.student_id_by_token(p_token);
  v_liked  boolean;
  v_count  bigint;
begin
  if not (select voting_open from public.settings where id = 1) then
    raise exception '지금은 투표 기간이 아닙니다.' using hint = 'VOTING_CLOSED';
  end if;
  if v_sid is null then
    -- 로그인 전이거나, 다른 기기에서 로그인해서 이 기기의 연결이 끊긴 경우
    raise exception '로그인이 필요합니다. 다른 기기에서 로그인했다면 이 기기에서 다시 로그인해 주세요.' using hint = 'NOT_LOGGED_IN';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and hidden = false) then
    raise exception '작품을 찾을 수 없습니다.' using hint = 'NO_ARTWORK';
  end if;

  delete from public.likes where artwork_id = p_artwork_id and student_id = v_sid;
  if found then
    v_liked := false;
  else
    insert into public.likes (artwork_id, student_id) values (p_artwork_id, v_sid);
    v_liked := true;
  end if;

  select count(*) into v_count from public.likes where artwork_id = p_artwork_id;
  return jsonb_build_object('liked', v_liked, 'count', v_count);
end;
$$;

-- 4-5. 댓글 작성 (200자 제한, 작성자명은 저장 시점에 마스킹)
create or replace function public.add_comment(p_token uuid, p_artwork_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid   uuid := public.student_id_by_token(p_token);
  v_name  text;
  v_body  text := trim(coalesce(p_body, ''));
  c       public.comments%rowtype;
begin
  if not (select voting_open from public.settings where id = 1) then
    raise exception '지금은 투표 기간이 아닙니다.' using hint = 'VOTING_CLOSED';
  end if;
  if v_sid is null then
    raise exception '로그인이 필요합니다. 다른 기기에서 로그인했다면 이 기기에서 다시 로그인해 주세요.' using hint = 'NOT_LOGGED_IN';
  end if;
  if char_length(v_body) = 0 then
    raise exception '댓글 내용을 입력해 주세요.' using hint = 'EMPTY';
  end if;
  if char_length(v_body) > 200 then
    raise exception '댓글은 200자까지 쓸 수 있습니다.' using hint = 'TOO_LONG';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and hidden = false) then
    raise exception '작품을 찾을 수 없습니다.' using hint = 'NO_ARTWORK';
  end if;

  select name into v_name from public.students where id = v_sid;

  insert into public.comments (artwork_id, student_id, body, masked_name)
  values (p_artwork_id, v_sid, v_body, public.mask_name(v_name))
  returning * into c;

  return jsonb_build_object(
    'id',          c.id,
    'artwork_id',  c.artwork_id,
    'student_id',  c.student_id,
    'body',        c.body,
    'masked_name', c.masked_name,
    'created_at',  c.created_at
  );
end;
$$;

-- 4-6. 내 댓글 삭제 (본인 것만)
create or replace function public.delete_my_comment(p_token uuid, p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid uuid := public.student_id_by_token(p_token);
begin
  if v_sid is null then
    raise exception '로그인이 필요합니다.' using hint = 'NOT_LOGGED_IN';
  end if;
  delete from public.comments where id = p_comment_id and student_id = v_sid;
  if not found then
    raise exception '삭제할 수 있는 댓글이 아닙니다.' using hint = 'NOT_OWNER';
  end if;
end;
$$;

-- 4-7. 로그아웃: 이 기기의 토큰을 무효화
create or replace function public.logout_device(p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.students set device_hash = null
   where p_token is not null and device_hash = public.token_hash(p_token);
$$;

-- 4-8. 작품별 하트 수 / (숨기지 않은) 댓글 수
--   likes 표는 학생이 읽을 수 없으므로, 집계만 이 함수로 공개합니다.
create or replace function public.get_artwork_stats()
returns table (artwork_id uuid, like_count bigint, comment_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.id as artwork_id,
         (select count(*) from public.likes    l where l.artwork_id = a.id)                      as like_count,
         (select count(*) from public.comments c where c.artwork_id = a.id and c.hidden = false) as comment_count
    from public.artworks a
   where a.hidden = false or public.is_admin();
$$;


-- ---------------------------------------------------------------------
-- 5. 관리자 등록 함수
-- ---------------------------------------------------------------------

-- 가입 코드가 맞는지만 확인 (계정을 만들기 "전"에 검사해서 쓸모없는 계정이 생기지 않게 함)
create or replace function public.verify_admin_code(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.secrets
    where key = 'admin_signup_code' and value = coalesce(p_code, '')
  );
$$;

-- 가입 코드로 관리자 등록
--   admin.html 의 흐름:
--     1) verify_admin_code 로 코드 확인
--     2) supabase.auth.signUp({ email, password })  → auth.users 에 계정 생성
--     3) supabase.rpc('register_admin', { p_email, p_code })  → 이 함수
--        - 가입 코드 재확인
--        - 이메일 인증을 기다리지 않도록 email_confirmed_at 을 채워 즉시 활성화
--        - admins 표에 이메일 추가
--     4) supabase.auth.signInWithPassword(...)
--   "Confirm email" 설정이 켜져 있어도 꺼져 있어도 동작합니다.
create or replace function public.register_admin(p_email text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   text;
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_uid    uuid;
begin
  select value into v_code from public.secrets where key = 'admin_signup_code';
  if v_code is null or coalesce(p_code, '') = '' or p_code <> v_code then
    raise exception '관리자 가입 코드가 올바르지 않습니다.' using hint = 'INVALID_CODE';
  end if;

  select id into v_uid
    from auth.users
   where lower(email) = v_email
     and coalesce(is_anonymous, false) = false
   order by created_at desc
   limit 1;

  if v_uid is null then
    raise exception '해당 이메일로 만든 계정이 없습니다. 먼저 계정을 만들어 주세요.' using hint = 'USER_NOT_FOUND';
  end if;

  -- 이메일 인증 없이 바로 로그인할 수 있도록 활성화
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at         = now()
   where id = v_uid;

  insert into public.admins (email, created_by)
  values (v_email, coalesce(auth.email(), 'signup-code'))
  on conflict (email) do nothing;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 함수 실행 권한
--    기본적으로 새 함수는 모든 역할이 실행할 수 있으므로, 내부용 함수는 회수하고
--    학생용 함수는 anon(학생 화면) 과 authenticated 둘 다에 허용합니다.
-- ---------------------------------------------------------------------
-- 내부용: 클라이언트가 직접 부를 수 없게 함
revoke execute on function public.student_id_by_token(uuid) from public, anon, authenticated;
revoke execute on function public.token_hash(uuid)          from public, anon, authenticated;

-- 학생용
grant execute on function public.claim_student(text, text, text, boolean) to anon, authenticated;
grant execute on function public.get_my_profile(uuid)                     to anon, authenticated;
grant execute on function public.get_my_likes(uuid)                       to anon, authenticated;
grant execute on function public.toggle_like(uuid, uuid)                  to anon, authenticated;
grant execute on function public.add_comment(uuid, uuid, text)            to anon, authenticated;
grant execute on function public.delete_my_comment(uuid, uuid)            to anon, authenticated;
grant execute on function public.logout_device(uuid)                      to anon, authenticated;
grant execute on function public.get_artwork_stats()                      to anon, authenticated;

-- 관리자 관련
grant execute on function public.register_admin(text, text) to anon, authenticated;
grant execute on function public.verify_admin_code(text)    to anon, authenticated;
grant execute on function public.is_admin()                 to anon, authenticated;
grant execute on function public.normalize_school(text)     to anon, authenticated;
grant execute on function public.mask_name(text)            to anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. Storage: 작품 이미지 버킷 (공개 읽기, 관리자만 업로드/삭제)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artworks', 'artworks', true,
  10485760,                                                     -- 파일 1개 최대 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "artworks_bucket_public_read" on storage.objects;
create policy "artworks_bucket_public_read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'artworks');

drop policy if exists "artworks_bucket_admin_insert" on storage.objects;
create policy "artworks_bucket_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'artworks' and public.is_admin());

drop policy if exists "artworks_bucket_admin_update" on storage.objects;
create policy "artworks_bucket_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'artworks' and public.is_admin())
  with check (bucket_id = 'artworks' and public.is_admin());

drop policy if exists "artworks_bucket_admin_delete" on storage.objects;
create policy "artworks_bucket_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'artworks' and public.is_admin());


-- ---------------------------------------------------------------------
-- 8. 확인용 (실행 결과창에 표시됨)
-- ---------------------------------------------------------------------
select 'schema ok (v2 token)' as status,
       (select count(*) from public.admins)   as admin_count,
       (select voting_open from public.settings where id = 1) as voting_open;
