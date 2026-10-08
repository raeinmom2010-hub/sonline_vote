/* =====================================================================
   관리자(교사) 페이지 로직 (admin.html)
   ---------------------------------------------------------------------
   - 로그인: Supabase 이메일+비밀번호. 로그인 후 is_admin() 으로 관리자 여부 확인
   - 계정 만들기: verify_admin_code → auth.signUp → register_admin → 로그인
   - 데이터 읽기/쓰기: 관리자는 RLS 정책(is_admin())으로 테이블을 직접 다룸
   - 이미지: Storage 'artworks' 버킷에 업로드 후 artworks 표에 행 추가
   ===================================================================== */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  if (!CFG || !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    alert('js/config.js 에 Supabase URL 과 anon key 를 입력해 주세요.');
    return;
  }

  // 학생 페이지(index.html)와 세션 저장 공간을 분리합니다.
  // 같은 브라우저에서 교사 로그인과 학생 익명 로그인이 서로 덮어쓰지 않게 하기 위함입니다.
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'sonline-admin-auth' },
  });

  // 교사 추가용 임시 클라이언트: 세션을 저장하지 않으므로 signUp 을 해도 현재 로그인이 바뀌지 않음
  function tempClient() {
    return window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sonline-temp-' + Date.now() },
    });
  }

  const $ = (id) => document.getElementById(id);

  // ───────────────────────── 상태 ─────────────────────────
  const state = {
    email: null,
    settings: null,
    artworks: [],
    students: [],
    comments: [],
    admins: [],
    csvRows: [],          // 불러온 작품정보 CSV  [{title, author, description, keyword}]
    pending: [],          // 업로드 대기 파일  [{file, previewUrl, title, author, description, csvIndex, status, error}]
  };

  // ───────────────────────── 도우미 ─────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  function fmt(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function imageUrl(path) {
    return sb.storage.from(CFG.BUCKET).getPublicUrl(path).data.publicUrl;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function showErr(id, msg) {
    const p = $(id);
    if (!msg) { p.classList.add('hidden'); return; }
    p.textContent = msg;
    p.classList.remove('hidden');
  }
  // Supabase 오류 → 한국어 안내
  function friendly(error) {
    const m = error?.message || '';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일이 아직 활성화되지 않았습니다. "관리자 계정 만들기"에서 가입 코드로 다시 등록해 주세요.';
    if (/User already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인 탭에서 로그인해 주세요.';
    if (/Password should be at least/i.test(m)) return '비밀번호는 6자 이상이어야 합니다.';
    if (/rate limit/i.test(m)) return '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.';
    if (/Signups not allowed/i.test(m)) return 'Supabase 에서 회원가입이 꺼져 있습니다. Authentication → Providers → Email 에서 켜 주세요.';
    return m || '알 수 없는 오류가 났습니다.';
  }

  // CSV 문자열 → 2차원 배열 (따옴표·줄바꿈·BOM 처리)
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  // 2차원 배열 → CSV 파일 다운로드 (엑셀용 UTF-8 BOM 포함)
  function downloadCsv(filename, rows) {
    const body = rows.map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  // ───────────────────────── 인증 ─────────────────────────

  async function checkAdmin() {
    const { data, error } = await sb.rpc('is_admin');
    if (error) throw error;
    return data === true;
  }

  async function enterApp(session) {
    const ok = await checkAdmin();
    if (!ok) {
      await sb.auth.signOut();
      showErr('loginError', '이 계정은 관리자로 등록되어 있지 않습니다.\n"관리자 계정 만들기" 탭에서 가입 코드로 등록하거나 다른 교사에게 추가를 요청하세요.');
      return false;
    }
    state.email = session.user.email;
    $('adminEmail').textContent = state.email;
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    showPanel('dashboard');
    return true;
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    showErr('loginError', '');
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) return showErr('loginError', '이메일과 비밀번호를 입력하세요.');
    $('loginSubmit').disabled = true;
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return showErr('loginError', friendly(error));
      await enterApp(data.session);
    } catch (err) {
      showErr('loginError', friendly(err));
    } finally {
      $('loginSubmit').disabled = false;
    }
  }

  // 계정 생성 → 활성화 → 관리자 등록 → 로그인 (한 번에)
  async function handleSignup(ev) {
    ev.preventDefault();
    showErr('signupError', '');
    const email = $('signupEmail').value.trim();
    const password = $('signupPassword').value;
    const code = $('signupCode').value;
    if (!email || !password || !code) return showErr('signupError', '모든 칸을 입력하세요.');
    if (password.length < 6) return showErr('signupError', '비밀번호는 6자 이상이어야 합니다.');

    $('signupSubmit').disabled = true;
    try {
      // 1) 가입 코드 먼저 확인 (틀리면 계정을 만들지 않음)
      const { data: okCode, error: e0 } = await sb.rpc('verify_admin_code', { p_code: code });
      if (e0) return showErr('signupError', friendly(e0));
      if (!okCode) return showErr('signupError', '관리자 가입 코드가 올바르지 않습니다.');

      // 2) 계정 생성 (이미 있는 이메일이면 그대로 진행해서 관리자 등록만 시도)
      const { error: e1 } = await sb.auth.signUp({ email, password });
      if (e1 && !/already registered/i.test(e1.message)) return showErr('signupError', friendly(e1));

      // 3) 활성화 + 관리자 등록
      const { error: e2 } = await sb.rpc('register_admin', { p_email: email, p_code: code });
      if (e2) return showErr('signupError', friendly(e2));

      // 4) 로그인
      const { data, error: e3 } = await sb.auth.signInWithPassword({ email, password });
      if (e3) return showErr('signupError', friendly(e3));
      await enterApp(data.session);
      toast('관리자 계정이 만들어졌습니다.');
    } catch (err) {
      showErr('signupError', friendly(err));
    } finally {
      $('signupSubmit').disabled = false;
    }
  }

  async function handleLogout() {
    await sb.auth.signOut();
    location.reload();
  }

  // ───────────────────────── 패널 전환 ─────────────────────────
  const loaders = {
    dashboard: loadDashboard,
    artworks: loadArtworks,
    students: loadStudents,
    comments: loadComments,
    results: loadResults,
    admins: loadAdmins,
  };
  function showPanel(name) {
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-' + name));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.panel === name));
    loaders[name]?.().catch((err) => { console.error(err); toast('불러오기 실패: ' + friendly(err)); });
  }

  // ───────────────────────── 대시보드 ─────────────────────────
  async function loadDashboard() {
    const [{ data: settings, error }, a, s, l, c] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).single(),
      sb.from('artworks').select('*', { count: 'exact', head: true }),
      sb.from('students').select('*', { count: 'exact', head: true }),
      sb.from('likes').select('*', { count: 'exact', head: true }),
      sb.from('comments').select('*', { count: 'exact', head: true }),
    ]);
    if (error) throw error;
    state.settings = settings;
    renderVoting();
    $('siteTitleInput').value = settings.site_title || '';
    $('siteNoticeInput').value = settings.site_notice || '';
    $('statArtworks').textContent = a.count ?? '-';
    $('statStudents').textContent = s.count ?? '-';
    $('statLikes').textContent = l.count ?? '-';
    $('statComments').textContent = c.count ?? '-';
  }

  function renderVoting() {
    const open = !!state.settings?.voting_open;
    $('votingToggle').checked = open;
    $('votingStateText').textContent = open
      ? '투표 진행 중 - 학생이 하트와 댓글을 남길 수 있습니다.'
      : '투표 마감 - 학생은 작품을 보기만 할 수 있습니다.';
  }

  async function handleVotingToggle() {
    const toggle = $('votingToggle');
    const next = toggle.checked;
    toggle.disabled = true;
    const { error } = await sb.from('settings').update({ voting_open: next, updated_at: new Date().toISOString() }).eq('id', 1);
    toggle.disabled = false;
    if (error) { toggle.checked = !next; return toast('변경 실패: ' + friendly(error)); }
    state.settings.voting_open = next;
    renderVoting();
    toast(next ? '투표를 시작했습니다.' : '투표를 마감했습니다.');
  }

  async function handleSettingsSave(ev) {
    ev.preventDefault();
    const { error } = await sb.from('settings').update({
      site_title: $('siteTitleInput').value.trim() || '캐릭터 공모전 투표',
      site_notice: $('siteNoticeInput').value.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (error) return toast('저장 실패: ' + friendly(error));
    toast('저장했습니다.');
  }

  // ───────────────────────── 작품: CSV 불러오기 ─────────────────────────
  async function handleCsvFile(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) { $('csvStatus').textContent = '내용이 없는 파일입니다.'; return; }

    // 헤더 행이 있으면 이름으로 열을 찾고, 없으면 순서대로(제목, 출품자, 설명, 키워드)
    const header = rows[0].map((h) => h.trim());
    const findCol = (words, fallback) => {
      const i = header.findIndex((h) => words.some((w) => h.includes(w)));
      return i >= 0 ? i : fallback;
    };
    const hasHeader = header.some((h) => /제목|출품자|설명|키워드|파일/.test(h));
    const col = {
      title: findCol(['제목'], 0),
      author: findCol(['출품자', '이름', '학생'], 1),
      description: findCol(['설명', '소개'], 2),
      keyword: findCol(['키워드', '파일'], 3),
    };
    const body = hasHeader ? rows.slice(1) : rows;
    state.csvRows = body.map((r) => ({
      title: (r[col.title] || '').trim(),
      author: (r[col.author] || '').trim(),
      description: (r[col.description] || '').trim(),
      keyword: (r[col.keyword] || '').trim(),
    })).filter((r) => r.title);
    $('csvStatus').textContent = `작품 정보 ${state.csvRows.length}건을 불러왔습니다.`;
    // 이미 올려둔 대기 파일에도 다시 짝짓기
    state.pending.forEach((p) => { if (p.csvIndex < 0) applyCsvMatch(p); });
    renderPending();
    ev.target.value = '';
  }

  // 파일명에 CSV 의 키워드가 들어 있으면 자동으로 짝지음 (키워드는 | 로 여러 개 가능)
  function applyCsvMatch(p) {
    const fname = p.file.name.toLowerCase();
    const idx = state.csvRows.findIndex((r) =>
      r.keyword.split(/[|;]/).map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => fname.includes(k))
    );
    if (idx >= 0) assignCsv(p, idx);
  }
  function assignCsv(p, idx) {
    p.csvIndex = idx;
    if (idx >= 0) {
      const r = state.csvRows[idx];
      p.title = r.title; p.author = r.author; p.description = r.description;
    }
  }

  // ───────────────────────── 작품: 업로드 대기 목록 ─────────────────────────
  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return toast('이미지 파일만 올릴 수 있습니다.');
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { toast(`${file.name}: 10MB 를 넘어 제외했습니다.`); continue; }
      const p = {
        file, previewUrl: URL.createObjectURL(file),
        title: file.name.replace(/\.[^.]+$/, ''), author: '', description: '',
        csvIndex: -1, status: 'ready', error: '',
      };
      applyCsvMatch(p);
      state.pending.push(p);
    }
    renderPending();
  }

  function renderPending() {
    const list = $('pendingList');
    $('uploadBar').classList.toggle('hidden', state.pending.length === 0);
    const csvOptions = (sel) => `<option value="-1">직접 입력</option>` +
      state.csvRows.map((r, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(r.title)}${r.author ? ' - ' + esc(r.author) : ''}</option>`).join('');

    list.innerHTML = state.pending.map((p, i) => `
      <div class="pending-item ${p.status === 'done' ? 'is-done' : ''} ${p.status === 'error' ? 'is-error' : ''}" data-i="${i}">
        <img class="thumb" src="${p.previewUrl}" alt="">
        <div class="pending-fields">
          <input data-f="title" placeholder="제목" value="${esc(p.title)}">
          <input data-f="author" placeholder="출품자" value="${esc(p.author)}">
          <textarea class="full" data-f="description" rows="2" placeholder="작품 설명">${esc(p.description)}</textarea>
          ${state.csvRows.length ? `<select class="full" data-f="csv">${csvOptions(p.csvIndex)}</select>` : ''}
          <div class="pending-meta">
            <span class="fname">${esc(p.file.name)} · ${(p.file.size / 1024 / 1024).toFixed(1)}MB
              ${p.status === 'done' ? ' · <b>업로드 완료</b>' : ''}${p.status === 'error' ? ' · <b>실패: ' + esc(p.error) + '</b>' : ''}</span>
            <button class="btn btn-sm" type="button" data-remove="${i}">제외</button>
          </div>
        </div>
      </div>`).join('');
  }

  // 대기 목록 입력값 변경 반영 (이벤트 위임)
  function onPendingInput(ev) {
    const item = ev.target.closest('.pending-item');
    if (!item) return;
    const p = state.pending[Number(item.dataset.i)];
    const f = ev.target.dataset.f;
    if (!p || !f) return;
    if (f === 'csv') {
      assignCsv(p, Number(ev.target.value));
      renderPending();
    } else {
      p[f] = ev.target.value;
    }
  }

  async function uploadAll() {
    const targets = state.pending.filter((p) => p.status !== 'done');
    if (!targets.length) return toast('업로드할 파일이 없습니다.');
    if (targets.some((p) => !p.title.trim())) return toast('제목이 비어 있는 작품이 있습니다.');

    $('uploadBtn').disabled = true;
    let done = 0;
    const baseOrder = state.artworks.length ? Math.max(...state.artworks.map((a) => a.sort_order || 0)) + 1 : 1;

    for (const [i, p] of targets.entries()) {
      $('uploadStatus').textContent = `업로드 중… ${done}/${targets.length}`;
      try {
        // 파일 이름은 한글·공백 문제를 피하려고 시간+난수로 새로 만듭니다.
        const ext = (p.file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const { error: upErr } = await sb.storage.from(CFG.BUCKET).upload(path, p.file, {
          contentType: p.file.type, cacheControl: '3600', upsert: false,
        });
        if (upErr) throw upErr;

        const { error: insErr } = await sb.from('artworks').insert({
          title: p.title.trim(), author: p.author.trim(), description: p.description.trim(),
          image_path: path, sort_order: baseOrder + i,
        });
        if (insErr) {
          await sb.storage.from(CFG.BUCKET).remove([path]);   // 행 추가 실패 시 올린 파일 정리
          throw insErr;
        }
        p.status = 'done';
        done++;
      } catch (err) {
        p.status = 'error';
        p.error = friendly(err);
      }
      renderPending();
    }
    $('uploadStatus').textContent = `완료 ${done}/${targets.length}`;
    $('uploadBtn').disabled = false;
    // 성공한 항목은 목록에서 정리
    state.pending = state.pending.filter((p) => p.status !== 'done');
    renderPending();
    toast(`${done}개 작품을 등록했습니다.`);
    await loadArtworks();
  }

  // ───────────────────────── 작품: 등록된 목록 ─────────────────────────
  async function loadArtworks() {
    const { data, error } = await sb.from('artworks').select('*').order('sort_order').order('created_at');
    if (error) throw error;
    state.artworks = data || [];
    $('artworkCount').textContent = `${state.artworks.length}개`;
    const list = $('artworkList');
    if (!state.artworks.length) { list.innerHTML = '<p class="muted">등록된 작품이 없습니다.</p>'; return; }
    list.innerHTML = state.artworks.map((a) => `
      <div class="artwork-item ${a.hidden ? 'is-hidden' : ''}" data-id="${a.id}">
        <img class="thumb" src="${esc(imageUrl(a.image_path))}" alt="">
        <div class="artwork-fields">
          <input data-f="title" value="${esc(a.title)}" placeholder="제목">
          <input data-f="author" value="${esc(a.author)}" placeholder="출품자">
          <input data-f="sort_order" type="number" value="${a.sort_order}" title="정렬 순서">
          <textarea class="full" data-f="description" rows="3" placeholder="설명">${esc(a.description)}</textarea>
          <div class="artwork-actions">
            ${a.hidden ? '<span class="badge hidden-badge">숨김</span>' : '<span class="badge ok">공개</span>'}
            <span class="muted small">${fmt(a.created_at)}</span>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-primary" type="button" data-act="save">저장</button>
            <button class="btn btn-sm" type="button" data-act="toggle">${a.hidden ? '보이기' : '숨김'}</button>
            <button class="btn btn-sm btn-danger" type="button" data-act="delete">삭제</button>
          </div>
        </div>
      </div>`).join('');
  }

  async function onArtworkAction(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const item = btn.closest('.artwork-item');
    const id = item.dataset.id;
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    const act = btn.dataset.act;
    const val = (f) => item.querySelector(`[data-f="${f}"]`).value;

    if (act === 'save') {
      const patch = {
        title: val('title').trim(), author: val('author').trim(),
        description: val('description').trim(), sort_order: Number(val('sort_order')) || 0,
      };
      if (!patch.title) return toast('제목을 입력하세요.');
      const { error } = await sb.from('artworks').update(patch).eq('id', id);
      if (error) return toast('저장 실패: ' + friendly(error));
      Object.assign(a, patch);
      toast('저장했습니다.');
    } else if (act === 'toggle') {
      const { error } = await sb.from('artworks').update({ hidden: !a.hidden }).eq('id', id);
      if (error) return toast('변경 실패: ' + friendly(error));
      await loadArtworks();
    } else if (act === 'delete') {
      if (!confirm(`"${a.title}" 작품을 삭제할까요?\n이미지 파일과 이 작품의 하트·댓글이 모두 지워집니다.`)) return;
      const { error } = await sb.from('artworks').delete().eq('id', id);
      if (error) return toast('삭제 실패: ' + friendly(error));
      const { error: sErr } = await sb.storage.from(CFG.BUCKET).remove([a.image_path]);
      if (sErr) console.warn('이미지 파일 삭제 실패', sErr);
      toast('삭제했습니다.');
      await loadArtworks();
    }
  }

  // ───────────────────────── 학생 ─────────────────────────
  async function loadStudents() {
    const { data, error } = await sb.from('students')
      .select('id, school, student_no, name, auth_uid, last_login_at, created_at')
      .order('last_login_at', { ascending: false });
    if (error) throw error;
    state.students = data || [];
    renderStudents();
  }

  function filteredStudents() {
    const q = $('studentSearch').value.trim().toLowerCase();
    if (!q) return state.students;
    return state.students.filter((s) => `${s.school} ${s.student_no} ${s.name}`.toLowerCase().includes(q));
  }

  function renderStudents() {
    const list = filteredStudents();
    $('studentCount').textContent = `${list.length}명${list.length !== state.students.length ? ` / 전체 ${state.students.length}명` : ''}`;
    $('studentBody').innerHTML = list.length ? list.map((s) => `
      <tr data-id="${s.id}">
        <td>${esc(s.school)}</td>
        <td>${esc(s.student_no)}</td>
        <td>${esc(s.name)}</td>
        <td>${fmt(s.last_login_at)}</td>
        <td>${s.auth_uid ? '<span class="badge ok">연결됨</span>' : '<span class="badge off">해제됨</span>'}</td>
        <td class="actions">
          <button class="btn btn-sm" type="button" data-act="unlink" ${s.auth_uid ? '' : 'disabled'}>기기 연결 해제</button>
          <button class="btn btn-sm btn-danger" type="button" data-act="delete">삭제</button>
        </td>
      </tr>`).join('') : '<tr><td class="empty" colspan="6">학생이 없습니다.</td></tr>';
  }

  async function onStudentAction(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const s = state.students.find((x) => x.id === id);
    if (!s) return;
    if (btn.dataset.act === 'unlink') {
      const { error } = await sb.from('students').update({ auth_uid: null }).eq('id', id);
      if (error) return toast('실패: ' + friendly(error));
      s.auth_uid = null;
      renderStudents();
      toast(`${s.name} 학생의 기기 연결을 해제했습니다.`);
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`${s.school} ${s.student_no} ${s.name} 학생의 프로필을 삭제할까요?\n이 학생의 하트와 댓글도 모두 지워집니다.`)) return;
      const { error } = await sb.from('students').delete().eq('id', id);
      if (error) return toast('실패: ' + friendly(error));
      state.students = state.students.filter((x) => x.id !== id);
      renderStudents();
      toast('삭제했습니다.');
    }
  }

  function exportStudentsCsv() {
    const rows = [['학교', '학번', '이름', '마지막 로그인', '첫 로그인', '기기 연결']];
    filteredStudents().forEach((s) => rows.push([s.school, s.student_no, s.name, fmt(s.last_login_at), fmt(s.created_at), s.auth_uid ? '연결됨' : '해제됨']));
    downloadCsv(`학생목록_${today()}.csv`, rows);
  }

  // ───────────────────────── 댓글 ─────────────────────────
  async function loadComments() {
    // students / artworks 를 함께 가져옴 (관리자는 RLS 로 실명 조회 가능)
    const { data, error } = await sb.from('comments')
      .select('id, body, masked_name, hidden, created_at, artwork_id, students(school, student_no, name), artworks(title)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    state.comments = data || [];
    renderComments();
  }

  function renderComments() {
    const hiddenOnly = $('hiddenOnly').checked;
    const list = hiddenOnly ? state.comments.filter((c) => c.hidden) : state.comments;
    $('commentCount').textContent = `${list.length}개`;
    $('commentBody').innerHTML = list.length ? list.map((c) => `
      <tr data-id="${c.id}" class="${c.hidden ? 'is-hidden' : ''}">
        <td>${fmt(c.created_at)}</td>
        <td>${c.students ? `${esc(c.students.name)}<br><span class="muted small">${esc(c.students.school)} ${esc(c.students.student_no)}</span>` : '<span class="muted">(삭제된 학생)</span>'}
            <br><span class="muted small">표시명 ${esc(c.masked_name)}</span></td>
        <td>${esc(c.artworks?.title || '(삭제된 작품)')}</td>
        <td class="body">${esc(c.body)}</td>
        <td>${c.hidden ? '<span class="badge hidden-badge">숨김</span>' : '<span class="badge ok">공개</span>'}</td>
        <td class="actions">
          <button class="btn btn-sm" type="button" data-act="toggle">${c.hidden ? '보이기' : '숨김'}</button>
          <button class="btn btn-sm btn-danger" type="button" data-act="delete">삭제</button>
        </td>
      </tr>`).join('') : '<tr><td class="empty" colspan="6">댓글이 없습니다.</td></tr>';
  }

  async function onCommentAction(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    if (btn.dataset.act === 'toggle') {
      const { error } = await sb.from('comments').update({ hidden: !c.hidden }).eq('id', id);
      if (error) return toast('실패: ' + friendly(error));
      c.hidden = !c.hidden;
      renderComments();
    } else if (btn.dataset.act === 'delete') {
      if (!confirm('이 댓글을 완전히 삭제할까요?')) return;
      const { error } = await sb.from('comments').delete().eq('id', id);
      if (error) return toast('실패: ' + friendly(error));
      state.comments = state.comments.filter((x) => x.id !== id);
      renderComments();
      toast('삭제했습니다.');
    }
  }

  // ───────────────────────── 결과 ─────────────────────────
  let resultRows = [];
  async function loadResults() {
    const [{ data: arts, error: e1 }, { data: stats, error: e2 }] = await Promise.all([
      sb.from('artworks').select('id, title, author, hidden').order('sort_order'),
      sb.rpc('get_artwork_stats'),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    const sm = new Map((stats || []).map((r) => [r.artwork_id, r]));
    resultRows = (arts || []).map((a) => ({
      ...a,
      likes: Number(sm.get(a.id)?.like_count || 0),
      comments: Number(sm.get(a.id)?.comment_count || 0),
    })).sort((x, y) => (y.likes - x.likes) || (y.comments - x.comments));

    let rank = 0, prev = null;
    $('resultBody').innerHTML = resultRows.length ? resultRows.map((r, i) => {
      if (r.likes !== prev) { rank = i + 1; prev = r.likes; }   // 동점이면 같은 순위
      r.rank = rank;
      return `
      <tr>
        <td class="rank">${rank}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.author)}</td>
        <td><b>${r.likes}</b></td>
        <td>${r.comments}</td>
        <td>${r.hidden ? '<span class="badge hidden-badge">숨김</span>' : '<span class="badge ok">공개</span>'}</td>
      </tr>`;
    }).join('') : '<tr><td class="empty" colspan="6">작품이 없습니다.</td></tr>';
  }

  function exportSummaryCsv() {
    const rows = [['순위', '작품', '출품자', '하트', '댓글', '상태']];
    resultRows.forEach((r) => rows.push([r.rank, r.title, r.author, r.likes, r.comments, r.hidden ? '숨김' : '공개']));
    downloadCsv(`결과_작품별집계_${today()}.csv`, rows);
  }

  async function exportLikesCsv() {
    const { data, error } = await sb.from('likes')
      .select('created_at, artworks(title, author), students(school, student_no, name)')
      .order('created_at');
    if (error) return toast('실패: ' + friendly(error));
    const rows = [['시간', '작품', '출품자', '학교', '학번', '이름']];
    (data || []).forEach((l) => rows.push([fmt(l.created_at), l.artworks?.title, l.artworks?.author, l.students?.school, l.students?.student_no, l.students?.name]));
    downloadCsv(`결과_하트상세_${today()}.csv`, rows);
  }

  async function exportCommentsCsv() {
    const { data, error } = await sb.from('comments')
      .select('created_at, body, masked_name, hidden, artworks(title), students(school, student_no, name)')
      .order('created_at');
    if (error) return toast('실패: ' + friendly(error));
    const rows = [['시간', '작품', '학교', '학번', '이름', '표시명', '내용', '상태']];
    (data || []).forEach((c) => rows.push([fmt(c.created_at), c.artworks?.title, c.students?.school, c.students?.student_no, c.students?.name, c.masked_name, c.body, c.hidden ? '숨김' : '공개']));
    downloadCsv(`결과_댓글상세_${today()}.csv`, rows);
  }

  // ───────────────────────── 교사 계정 ─────────────────────────
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('*').order('created_at');
    if (error) throw error;
    state.admins = data || [];
    $('adminBody').innerHTML = state.admins.map((a) => {
      const me = a.email.toLowerCase() === (state.email || '').toLowerCase();
      return `
      <tr data-email="${esc(a.email)}">
        <td>${esc(a.email)} ${me ? '<span class="badge">나</span>' : ''}</td>
        <td>${fmt(a.created_at)}</td>
        <td class="muted">${esc(a.created_by || '-')}</td>
        <td class="actions">
          <button class="btn btn-sm btn-danger" type="button" data-act="remove" ${me ? 'disabled title="본인은 해제할 수 없습니다"' : ''}>권한 해제</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function onAdminAction(ev) {
    const btn = ev.target.closest('[data-act="remove"]');
    if (!btn) return;
    const email = btn.closest('tr').dataset.email;
    if (!confirm(`${email} 의 관리자 권한을 해제할까요?\n(로그인 계정 자체는 남지만 관리 페이지를 쓸 수 없게 됩니다)`)) return;
    const { error } = await sb.from('admins').delete().eq('email', email);
    if (error) return toast('실패: ' + friendly(error));
    toast('권한을 해제했습니다.');
    await loadAdmins();
  }

  async function handleAddAdmin(ev) {
    ev.preventDefault();
    showErr('addAdminError', '');
    const email = $('newAdminEmail').value.trim();
    const password = $('newAdminPassword').value;
    const code = $('newAdminCode').value;
    if (!email || !password || !code) return showErr('addAdminError', '모든 칸을 입력하세요.');
    if (password.length < 6) return showErr('addAdminError', '비밀번호는 6자 이상이어야 합니다.');

    const { data: okCode, error: e0 } = await sb.rpc('verify_admin_code', { p_code: code });
    if (e0) return showErr('addAdminError', friendly(e0));
    if (!okCode) return showErr('addAdminError', '관리자 가입 코드가 올바르지 않습니다.');

    // 임시 클라이언트로 계정 생성 → 내 로그인 세션은 그대로 유지됨
    const { error: e1 } = await tempClient().auth.signUp({ email, password });
    if (e1 && !/already registered/i.test(e1.message)) return showErr('addAdminError', friendly(e1));

    const { error: e2 } = await sb.rpc('register_admin', { p_email: email, p_code: code });
    if (e2) return showErr('addAdminError', friendly(e2));

    $('newAdminEmail').value = ''; $('newAdminPassword').value = ''; $('newAdminCode').value = '';
    toast(`${email} 교사를 추가했습니다. 이메일과 임시 비밀번호를 전달해 주세요.`);
    await loadAdmins();
  }

  // ───────────────────────── 이벤트 연결 ─────────────────────────
  document.querySelectorAll('[data-authtab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-authtab]').forEach((x) => x.classList.toggle('is-active', x === b));
    $('loginForm').classList.toggle('hidden', b.dataset.authtab !== 'login');
    $('signupForm').classList.toggle('hidden', b.dataset.authtab !== 'signup');
  }));
  $('loginForm').addEventListener('submit', handleLogin);
  $('signupForm').addEventListener('submit', handleSignup);
  $('logoutBtn').addEventListener('click', handleLogout);
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));

  // 대시보드
  $('votingToggle').addEventListener('change', handleVotingToggle);
  $('settingsForm').addEventListener('submit', handleSettingsSave);

  // 작품
  $('csvInput').addEventListener('change', handleCsvFile);
  const dz = $('dropzone');
  dz.addEventListener('click', () => $('fileInput').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('pendingList').addEventListener('input', onPendingInput);
  $('pendingList').addEventListener('change', onPendingInput);
  $('pendingList').addEventListener('click', (e) => {
    const r = e.target.closest('[data-remove]');
    if (!r) return;
    const p = state.pending.splice(Number(r.dataset.remove), 1)[0];
    if (p) URL.revokeObjectURL(p.previewUrl);
    renderPending();
  });
  $('clearPendingBtn').addEventListener('click', () => { state.pending.forEach((p) => URL.revokeObjectURL(p.previewUrl)); state.pending = []; renderPending(); });
  $('uploadBtn').addEventListener('click', uploadAll);
  $('reloadArtworksBtn').addEventListener('click', () => showPanel('artworks'));
  $('artworkList').addEventListener('click', onArtworkAction);

  // 학생
  $('studentSearch').addEventListener('input', renderStudents);
  $('studentCsvBtn').addEventListener('click', exportStudentsCsv);
  $('reloadStudentsBtn').addEventListener('click', () => showPanel('students'));
  $('studentBody').addEventListener('click', onStudentAction);

  // 댓글
  $('hiddenOnly').addEventListener('change', renderComments);
  $('reloadCommentsBtn').addEventListener('click', () => showPanel('comments'));
  $('commentBody').addEventListener('click', onCommentAction);

  // 결과
  $('csvSummaryBtn').addEventListener('click', exportSummaryCsv);
  $('csvLikesBtn').addEventListener('click', exportLikesCsv);
  $('csvCommentsBtn').addEventListener('click', exportCommentsCsv);
  $('reloadResultsBtn').addEventListener('click', () => showPanel('results'));

  // 교사 계정
  $('adminBody').addEventListener('click', onAdminAction);
  $('addAdminForm').addEventListener('submit', handleAddAdmin);

  // ───────────────────────── 시작: 기존 세션이 있으면 바로 입장 ─────────────────────────
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session && !session.user?.is_anonymous) {
      try { await enterApp(session); } catch (err) { console.error(err); }
    }
  })();
})();
