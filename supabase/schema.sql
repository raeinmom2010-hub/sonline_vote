-- =====================================================================
--  학교 캐릭터 공모전 투표 사이트 - Supabase 스키마
-- =====================================================================
--  사용 방법
--    Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run
--
--  특징
--    * 여러 번 실행해도 안전합니다. (if not exists / or replace / drop policy if exists)
--    * 학생의 "쓰기"(로그인·하트·댓글)는 전부 SECURITY DEFINER 함수를 통해서만 가능하고,
--      테이블에 직접 insert/update/delete 하는 정책은 학생에게 없습니다.
--    * 교사(관리자)는 is_admin() 이 true 일 때만 테이블을 직접 다룰 수 있습니다.
--
--  용어
--    anon           : 로그인하지 않은 방문자 (갤러리 열람만 가능)
--    authenticated  : 로그인한 사용자. 학생(익명 로그인)과 교사(이메일 로그인) 둘 다 여기에 속함
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
--   (같은 학교를 다르게 적어도 같은 학생으로 인식하기 위함)
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


-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 1-1. 관리자(교사) 목록
--   이메일이 이 표에 있고 + 익명 계정이 아니면 관리자입니다. (is_admin() 참고)
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
--   SECURITY DEFINER 함수(register_admin) 안에서만 읽습니다.
create table if not exists public.secrets (
  key    text primary key,
  value  text not null
);
insert into public.secrets (key, value)
values ('admin_signup_code', 'sonline')          -- 기본 가입 코드. 운영 전에 바꾸는 것을 권장합니다.
on conflict (key) do nothing;

-- 1-4. 학생 프로필
--   * 같은 (정규화한 학교, 학번) 은 1명만 존재 → unique 인덱스로 보장
--   * auth_uid : 현재 이 학생과 연결된 익명 로그인 계정(= 기기). 다른 기기에서 다시 로그인하면
--                이 값이 새 계정으로 바뀌고, 이전 기기는 더 이상 투표할 수 없게 됩니다.
create table if not exists public.students (
  id             uuid primary key default gen_random_uuid(),
  school         text not null,                                                   -- 입력한 그대로의 학교명
  school_key     text generated always as (public.normalize_school(school)) stored, -- 비교용 정규화 학교명
  student_no     text not null,
  name           text not null,
  auth_uid       uuid unique,                                                     -- 연결된 기기(익명 계정). null 이면 연결 해제 상태
  consented_at   timestamptz,                                                     -- 개인정보 동의 시각
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);
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

-- 현재 로그인한 기기(익명 계정)에 연결된 학생 id. 없으면 null
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.students s where s.auth_uid = auth.uid() limit 1;
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

-- students: 학생은 "자기 프로필"만, 관리자는 전체 조회 / 수정(기기 연결 해제) / 삭제
drop policy if exists "students_select_own_or_admin" on public.students;
create policy "students_select_own_or_admin" on public.students
  for select to authenticated
  using (auth_uid = auth.uid() or public.is_admin());

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

-- likes: 학생은 "내가 누른 하트"만 조회(어떤 카드에 빨간 하트를 칠할지 알기 위해), 관리자는 전체 조회.
--        쓰기 정책은 없음 → toggle_like() 함수로만 가능. 전체 개수는 get_artwork_stats() 로만 제공.
drop policy if exists "likes_select_own_or_admin" on public.likes;
create policy "likes_select_own_or_admin" on public.likes
  for select to authenticated
  using (student_id = public.current_student_id() or public.is_admin());

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
-- 4. 학생용 함수 (모두 SECURITY DEFINER)
--    클라이언트(js/app.js)는 supabase.rpc('함수명', {인자}) 로 호출합니다.
--    오류 메시지는 한국어로 raise 하고, 프로그램이 구분해야 하는 경우 hint 에 코드를 넣습니다.
-- ---------------------------------------------------------------------

-- 4-1. 학생 로그인(프로필 연결)
--   흐름: 클라이언트가 먼저 supabase.auth.signInAnonymously() → 그 다음 이 함수를 호출
--   * (학교, 학번) 이 처음이면 프로필 생성
--   * 이미 있으면 이름이 같을 때만 "현재 기기"로 연결을 옮김 (학번 도용 방지)
--   * 이 기기가 전에 다른 학생과 연결돼 있었다면 그 연결은 끊음
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
  v_uid     uuid := auth.uid();
  v_school  text := regexp_replace(trim(coalesce(p_school, '')), '\s+', ' ', 'g');   -- 연속 공백은 1개로
  v_no      text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');     -- 학번은 공백 전부 제거
  v_name    text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');           -- 이름도 공백 제거
  v_key     text := public.normalize_school(v_school);
  s         public.students%rowtype;
begin
  if v_uid is null then
    raise exception '로그인 세션이 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.' using hint = 'NO_SESSION';
  end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true' then
    raise exception '학생 로그인은 익명 세션에서만 가능합니다.' using hint = 'NOT_ANON';
  end if;
  if not coalesce(p_consent, false) then
    raise exception '개인정보 수집·이용에 동의해야 참여할 수 있습니다.' using hint = 'NO_CONSENT';
  end if;
  if v_key = '' or v_no = '' or v_name = '' then
    raise exception '학교, 학번, 이름을 모두 입력해 주세요.' using hint = 'EMPTY';
  end if;
  if char_length(v_school) > 30 or char_length(v_no) > 20 or char_length(v_name) > 20 then
    raise exception '입력이 너무 깁니다. (학교 30자, 학번·이름 20자 이내)' using hint = 'TOO_LONG';
  end if;

  -- 이 기기가 다른 학생과 연결돼 있었다면 먼저 끊는다 (auth_uid 는 unique 이므로 필수)
  update public.students
     set auth_uid = null
   where auth_uid = v_uid
     and not (school_key = v_key and student_no = v_no);

  select * into s
    from public.students
   where school_key = v_key and student_no = v_no
   for update;

  if not found then
    -- 처음 참여하는 학생 → 프로필 생성
    begin
      insert into public.students (school, student_no, name, auth_uid, consented_at, last_login_at)
      values (v_school, v_no, v_name, v_uid, now(), now())
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
       set auth_uid      = v_uid,              -- 새 기기로 연결 이동 (이전 기기는 투표 불가)
           last_login_at = now(),
           consented_at  = coalesce(consented_at, now())
     where id = s.id
     returning * into s;
  end if;

  return jsonb_build_object(
    'id',         s.id,
    'school',     s.school,
    'student_no', s.student_no,
    'name',       s.name
  );
end;
$$;

-- 4-2. 하트 토글 (누르면 추가, 다시 누르면 취소)
--   반환: {"liked": true/false, "count": 현재 하트 수}
create or replace function public.toggle_like(p_artwork_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid    uuid;
  v_liked  boolean;
  v_count  bigint;
begin
  if not (select voting_open from public.settings where id = 1) then
    raise exception '지금은 투표 기간이 아닙니다.' using hint = 'VOTING_CLOSED';
  end if;

  select id into v_sid from public.students where auth_uid = auth.uid();
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

-- 4-3. 댓글 작성 (200자 제한, 작성자명은 저장 시점에 마스킹)
--   반환: 저장된 댓글 1건 (id, artwork_id, student_id, body, masked_name, created_at)
create or replace function public.add_comment(p_artwork_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid   uuid;
  v_name  text;
  v_body  text := trim(coalesce(p_body, ''));
  c       public.comments%rowtype;
begin
  if not (select voting_open from public.settings where id = 1) then
    raise exception '지금은 투표 기간이 아닙니다.' using hint = 'VOTING_CLOSED';
  end if;

  select id, name into v_sid, v_name from public.students where auth_uid = auth.uid();
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

-- 4-4. 내 댓글 삭제 (본인 것만)
create or replace function public.delete_my_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid uuid;
begin
  select id into v_sid from public.students where auth_uid = auth.uid();
  if v_sid is null then
    raise exception '로그인이 필요합니다.' using hint = 'NOT_LOGGED_IN';
  end if;

  delete from public.comments where id = p_comment_id and student_id = v_sid;
  if not found then
    raise exception '삭제할 수 있는 댓글이 아닙니다.' using hint = 'NOT_OWNER';
  end if;
end;
$$;

-- 4-5. 작품별 하트 수 / (숨기지 않은) 댓글 수
--   likes 표는 학생이 전체를 읽을 수 없으므로, 집계만 이 함수로 공개합니다. 로그인 전에도 호출 가능.
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

-- 가입 코드로 관리자 등록
--   admin.html 의 흐름:
--     1) supabase.auth.signUp({ email, password })  → auth.users 에 계정 생성
--     2) supabase.rpc('register_admin', { p_email, p_code })  → 이 함수
--        - secrets 표의 가입 코드와 비교
--        - 이메일 인증을 기다리지 않도록 email_confirmed_at 을 채워 즉시 활성화
--        - admins 표에 이메일 추가
--     3) supabase.auth.signInWithPassword(...)
--   "Confirm email" 설정이 켜져 있어도 꺼져 있어도 동작합니다.
--   로그인 후 대시보드의 "교사 추가"도 같은 함수를 씁니다.
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


-- ---------------------------------------------------------------------
-- 6. 함수 실행 권한
--    기본적으로 새 함수는 모든 역할이 실행할 수 있으므로, 한 번 회수한 뒤 필요한 역할에만 다시 부여합니다.
-- ---------------------------------------------------------------------
revoke execute on function public.claim_student(text, text, text, boolean) from public, anon;
grant  execute on function public.claim_student(text, text, text, boolean) to authenticated;

revoke execute on function public.toggle_like(uuid)        from public, anon;
grant  execute on function public.toggle_like(uuid)        to authenticated;

revoke execute on function public.add_comment(uuid, text)  from public, anon;
grant  execute on function public.add_comment(uuid, text)  to authenticated;

revoke execute on function public.delete_my_comment(uuid)  from public, anon;
grant  execute on function public.delete_my_comment(uuid)  to authenticated;

-- 아래 함수들은 로그인 전(anon)에도 필요
grant execute on function public.get_artwork_stats()        to anon, authenticated;
grant execute on function public.register_admin(text, text) to anon, authenticated;
grant execute on function public.verify_admin_code(text)    to anon, authenticated;
grant execute on function public.is_admin()                 to anon, authenticated;
grant execute on function public.current_student_id()       to anon, authenticated;
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
select 'schema ok' as status,
       (select count(*) from public.admins)   as admin_count,
       (select voting_open from public.settings where id = 1) as voting_open;
