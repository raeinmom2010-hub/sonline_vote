-- =====================================================================
--  교사(관리자) 계정 사전 등록 스크립트
-- =====================================================================
--  언제 쓰나요?
--    admin.html 의 "관리자 계정 만들기" 화면을 쓰지 않고, SQL 로 첫 교사 계정을 미리 만들어 둘 때.
--
--  사용 방법
--    1) 아래 "설정값" 두 줄에서 이메일과 비밀번호를 바꿉니다.
--       ★ 비밀번호를 바꾼 상태로 이 파일을 저장하거나 GitHub 에 올리지 마세요.
--         Supabase SQL Editor 에 붙여넣은 뒤 그 화면에서만 고치는 것을 권장합니다.
--    2) schema.sql 을 먼저 실행한 뒤, 이 스크립트를 SQL Editor 에서 실행합니다.
--    3) admin.html 에서 이메일 + 비밀번호로 로그인하면 됩니다. (이메일 인증 불필요)
--
--  같은 이메일로 다시 실행하면 비밀번호를 새 값으로 바꾸고, 관리자 등록 상태를 유지합니다.
-- =====================================================================

do $$
declare
  -- ───────── 설정값 (여기 두 줄만 바꾸세요) ─────────
  v_email     text := 'teacher@example.com';    -- 교사 이메일
  v_password  text := 'CHANGE_ME_비밀번호';       -- 로그인 비밀번호 (8자 이상 권장)
  -- ────────────────────────────────────────────────
  v_uid       uuid;
begin
  v_email := lower(trim(v_email));

  if v_email = '' or v_email = 'teacher@example.com' or v_password = 'CHANGE_ME_비밀번호' then
    raise exception '스크립트 위쪽의 v_email / v_password 값을 먼저 바꿔 주세요.';
  end if;
  if char_length(v_password) < 6 then
    raise exception '비밀번호는 6자 이상이어야 합니다. (Supabase 기본 규칙)';
  end if;

  -- 이미 있는 계정인지 확인
  select id into v_uid
    from auth.users
   where lower(email) = v_email
     and coalesce(is_anonymous, false) = false
   limit 1;

  if v_uid is null then
    -- 새 계정 생성 (Supabase Auth 가 기대하는 컬럼을 채워 넣음)
    v_uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')),   -- bcrypt 해시로 저장
      now(),                                                     -- 이메일 인증 완료 상태로 생성
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now(),
      '', '', '', '',                                            -- 빈 문자열이어야 로그인 시 오류가 나지 않음
      false, false
    );

    -- 이메일 로그인 제공자(identity) 연결. 이 행이 있어야 비밀번호 로그인이 됩니다.
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid, v_uid::text, 'email',
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
      now(), now(), now()
    );

    raise notice '새 교사 계정을 만들었습니다: %', v_email;
  else
    -- 이미 있는 계정 → 비밀번호 갱신 + 활성화
    update auth.users
       set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at         = now()
     where id = v_uid;

    raise notice '기존 계정의 비밀번호를 갱신했습니다: %', v_email;
  end if;

  -- 관리자 목록에 등록
  insert into public.admins (email, created_by)
  values (v_email, 'sql')
  on conflict (email) do nothing;
end
$$;

-- 확인
select email, created_at, created_by from public.admins order by created_at;
