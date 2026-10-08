/* =====================================================================
   학생용 투표 사이트 로직 (index.html)
   ---------------------------------------------------------------------
   흐름
     1. 페이지 로드 → 설정(투표 상태·제목·안내문), 작품 목록, 하트/댓글 수를 불러와 갤러리 표시
     2. 로그인 버튼 → 익명 로그인(signInAnonymously) → claim_student 함수로 학생 프로필 연결
     3. 하트 → toggle_like 함수 (화면은 먼저 바꾸고, 실패하면 되돌림 = 낙관적 업데이트)
     4. 댓글 → add_comment / delete_my_comment 함수
   학생이 테이블에 직접 쓰는 일은 없습니다. 쓰기는 전부 DB 함수(rpc)를 통해서만 합니다.
   ===================================================================== */
(function () {
  'use strict';

  // ───────────────────────── 설정 · 클라이언트 ─────────────────────────
  const CFG = window.APP_CONFIG;
  if (!CFG || !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    alert('js/config.js 에 Supabase URL 과 anon key 를 입력해 주세요.');
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // localStorage / sessionStorage 키
  const LS_STUDENT = 'vote_student';     // 마지막으로 로그인한 학생 정보 (기기 연결 해제 감지 + 입력칸 자동 채움)
  const SS_ORDER   = 'vote_order';       // 랜덤 정렬 순서 (브라우저 탭을 닫기 전까지 고정)
  const SS_SORT    = 'vote_sort';        // 선택한 정렬 방식

  // ───────────────────────── 상태 ─────────────────────────
  const state = {
    settings: { voting_open: false, site_title: '', site_notice: '' },
    artworks: [],                 // [{id, title, author, description, image_path, created_at, ...}]
    stats: new Map(),             // artwork_id → { like_count, comment_count }
    myLikes: new Set(),           // 내가 하트를 누른 artwork_id 들
    me: null,                     // { id, school, student_no, name } 또는 null
    sort: sessionStorage.getItem(SS_SORT) || 'random',
    order: [],                    // 랜덤 정렬용 artwork_id 순서
    pending: new Set(),           // 서버 응답을 기다리는 중인 하트(중복 클릭 방지)
    detailId: null,               // 상세 모달에 열려 있는 작품 id
    comments: [],                 // 상세 모달의 댓글 목록
  };

  // ───────────────────────── DOM 참조 ─────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    siteTitle: $('siteTitle'), userBadge: $('userBadge'), loginBtn: $('loginBtn'), logoutBtn: $('logoutBtn'),
    notice: $('noticeBox'), closedBanner: $('closedBanner'), deviceBanner: $('deviceBanner'),
    countLabel: $('countLabel'), gallery: $('gallery'), emptyState: $('emptyState'), errorState: $('errorState'),
    retryBtn: $('retryBtn'),
    loginDialog: $('loginDialog'), loginForm: $('loginForm'), loginError: $('loginError'), loginSubmit: $('loginSubmit'),
    inSchool: $('inSchool'), inStudentNo: $('inStudentNo'), inName: $('inName'), inConsent: $('inConsent'),
    detailDialog: $('detailDialog'), detailImage: $('detailImage'), detailTitle: $('detailTitle'),
    detailAuthor: $('detailAuthor'), detailHeart: $('detailHeart'), detailClosed: $('detailClosed'),
    detailDesc: $('detailDesc'), commentCount: $('commentCount'), commentList: $('commentList'),
    commentEmpty: $('commentEmpty'), commentForm: $('commentForm'), commentInput: $('commentInput'),
    commentLen: $('commentLen'), commentSubmit: $('commentSubmit'), commentClosedNote: $('commentClosedNote'),
    commentLoginNote: $('commentLoginNote'), commentLoginBtn: $('commentLoginBtn'),
    toast: $('toast'),
  };

  // ───────────────────────── 작은 도우미 함수 ─────────────────────────

  // 사용자 입력을 HTML 에 넣을 때 태그가 실행되지 않도록 치환
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  // Storage 경로 → 공개 이미지 URL
  function imageUrl(path) {
    return sb.storage.from(CFG.BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // "10. 8. 14:03" 형식
  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  function stat(id) {
    return state.stats.get(id) || { like_count: 0, comment_count: 0 };
  }

  // DB 함수가 돌려준 오류를 사람이 읽을 메시지 + 코드(hint)로 정리
  function errInfo(error) {
    return { code: error?.hint || error?.code || '', message: error?.message || '알 수 없는 오류가 났어요.' };
  }

  // ───────────────────────── 데이터 불러오기 ─────────────────────────

  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('voting_open, site_title, site_notice').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    applySettings();
  }

  function applySettings() {
    const s = state.settings;
    el.siteTitle.textContent = s.site_title || '캐릭터 공모전 투표';
    document.title = el.siteTitle.textContent;
    el.notice.textContent = s.site_notice || '';
    el.closedBanner.classList.toggle('hidden', !!s.voting_open);
  }

  async function loadArtworks() {
    const { data, error } = await sb
      .from('artworks')
      .select('id, title, author, description, image_path, sort_order, created_at')
      .eq('hidden', false)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    state.artworks = data || [];
    syncRandomOrder();
  }

  async function loadStats() {
    const { data, error } = await sb.rpc('get_artwork_stats');
    if (error) throw error;
    state.stats = new Map((data || []).map((r) => [r.artwork_id, { like_count: Number(r.like_count), comment_count: Number(r.comment_count) }]));
  }

  // 현재 기기(익명 세션)에 연결된 학생 프로필 확인
  async function loadMe() {
    state.me = null;
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user?.is_anonymous) return;

    const { data, error } = await sb.from('students').select('id, school, student_no, name').limit(1);
    if (error) { console.warn('프로필 조회 실패', error); return; }
    state.me = data && data[0] ? data[0] : null;
  }

  async function loadMyLikes() {
    state.myLikes = new Set();
    if (!state.me) return;
    const { data, error } = await sb.from('likes').select('artwork_id');
    if (error) { console.warn('내 하트 조회 실패', error); return; }
    state.myLikes = new Set((data || []).map((r) => r.artwork_id));
  }

  // 랜덤 순서: 세션 동안 고정. 새로 추가된 작품은 뒤쪽에 섞어서 붙임
  function syncRandomOrder() {
    let saved = [];
    try { saved = JSON.parse(sessionStorage.getItem(SS_ORDER) || '[]'); } catch (_) { saved = []; }
    const ids = new Set(state.artworks.map((a) => a.id));
    const kept = saved.filter((id) => ids.has(id));
    const fresh = state.artworks.map((a) => a.id).filter((id) => !kept.includes(id));
    for (let i = fresh.length - 1; i > 0; i--) {           // Fisher-Yates 셔플
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    state.order = kept.concat(fresh);
    sessionStorage.setItem(SS_ORDER, JSON.stringify(state.order));
  }

  // ───────────────────────── 갤러리 그리기 ─────────────────────────

  function sortedArtworks() {
    const list = state.artworks.slice();
    if (state.sort === 'popular') {
      list.sort((a, b) => {
        const sa = stat(a.id), sb2 = stat(b.id);
        return (sb2.like_count - sa.like_count) || (sb2.comment_count - sa.comment_count) || a.sort_order - b.sort_order;
      });
    } else if (state.sort === 'latest') {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      const pos = new Map(state.order.map((id, i) => [id, i]));
      list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
    return list;
  }

  function heartButtonHtml(id, large) {
    const liked = state.myLikes.has(id);
    const open = !!state.settings.voting_open;
    if (!open) {
      // 투표 마감: 하트 버튼 대신 안내 문구 (하트 수는 함께 보여줌)
      return `<span class="closed-note">투표 마감 · ♥ ${stat(id).like_count}</span>`;
    }
    return `
      <button class="heart-btn ${large ? 'heart-lg' : ''} ${liked ? 'is-liked' : ''}" type="button"
              data-heart="${id}" aria-pressed="${liked}" aria-label="하트">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.7-4.3-9.3-8.1C.6 9.8 1.6 5.6 5.1 4.3c2.2-.8 4.6 0 6 1.9 1.4-1.9 3.8-2.7 6-1.9 3.5 1.3 4.5 5.5 2.4 8.6C18.7 16.7 12 21 12 21z"/></svg>
        <span class="heart-count">${stat(id).like_count}</span>
      </button>`;
  }

  function cardHtml(a) {
    return `
      <article class="card" data-card="${a.id}">
        <button class="card-image-btn" type="button" data-open="${a.id}" aria-label="${esc(a.title)} 크게 보기">
          <img src="${esc(imageUrl(a.image_path))}" alt="${esc(a.title)}" loading="lazy"
               onerror="this.style.visibility='hidden'">
        </button>
        <div class="card-body">
          <h2 class="card-title">${esc(a.title)}</h2>
          <p class="card-author">${esc(a.author)}</p>
          <div class="card-actions">
            <span class="card-heart">${heartButtonHtml(a.id, false)}</span>
            <button class="comment-btn" type="button" data-open="${a.id}" aria-label="댓글 보기">
              💬 <span class="comment-count">${stat(a.id).comment_count}</span>
            </button>
          </div>
        </div>
      </article>`;
  }

  function renderSkeleton(n = 6) {
    el.gallery.innerHTML = Array.from({ length: n }, () => `
      <div class="skeleton">
        <div class="skeleton-img"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>`).join('');
  }

  function renderGallery() {
    el.errorState.classList.add('hidden');
    const list = sortedArtworks();
    el.countLabel.textContent = list.length ? `작품 ${list.length}개` : '';
    el.emptyState.classList.toggle('hidden', list.length > 0);
    el.gallery.innerHTML = list.map(cardHtml).join('');
    document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.sort === state.sort));
  }

  // 작품 1개의 하트/댓글 표시만 갱신 (전체를 다시 그리지 않음 → 깜빡임 없음)
  function refreshCard(id, animate) {
    const card = el.gallery.querySelector(`[data-card="${id}"]`);
    if (card) {
      const wrap = card.querySelector('.card-heart');
      wrap.innerHTML = heartButtonHtml(id, false);
      card.querySelector('.comment-count').textContent = stat(id).comment_count;
      if (animate) wrap.querySelector('.heart-btn')?.classList.add('pop');
    }
    if (state.detailId === id) refreshDetailHeart(animate);
  }

  function renderHeader() {
    if (state.me) {
      el.userBadge.textContent = `${state.me.school} ${state.me.student_no} ${state.me.name}`;
      el.userBadge.classList.remove('hidden');
      el.loginBtn.classList.add('hidden');
      el.logoutBtn.classList.remove('hidden');
    } else {
      el.userBadge.classList.add('hidden');
      el.loginBtn.classList.remove('hidden');
      el.logoutBtn.classList.add('hidden');
    }
  }

  function renderAll() {
    applySettings();
    renderHeader();
    renderGallery();
    if (state.detailId) renderDetailState();
  }

  // ───────────────────────── 초기 로드 ─────────────────────────

  async function loadAll() {
    renderSkeleton();
    el.emptyState.classList.add('hidden');
    el.errorState.classList.add('hidden');
    try {
      await Promise.all([loadSettings(), loadArtworks(), loadStats()]);
      await loadMe();
      await loadMyLikes();
      detectDeviceUnlink();
      renderAll();
    } catch (err) {
      console.error(err);
      el.gallery.innerHTML = '';
      el.errorState.classList.remove('hidden');
    }
  }

  // 전에 이 기기에서 로그인한 기록은 있는데 지금은 연결된 프로필이 없다 → 다른 기기에서 로그인한 것
  function detectDeviceUnlink() {
    const saved = readSavedStudent();
    el.deviceBanner.classList.toggle('hidden', !(saved && !state.me));
  }

  function readSavedStudent() {
    try { return JSON.parse(localStorage.getItem(LS_STUDENT) || 'null'); } catch (_) { return null; }
  }

  // ───────────────────────── 로그인 ─────────────────────────

  function openLogin() {
    const saved = readSavedStudent();
    if (saved) {   // 지난번 입력값으로 미리 채워 두기
      el.inSchool.value = el.inSchool.value || saved.school || '';
      el.inStudentNo.value = el.inStudentNo.value || saved.student_no || '';
      el.inName.value = el.inName.value || saved.name || '';
    }
    el.loginError.classList.add('hidden');
    if (!el.loginDialog.open) el.loginDialog.showModal();
    setTimeout(() => (el.inSchool.value ? el.inName : el.inSchool).focus(), 50);
  }

  function showLoginError(msg) {
    el.loginError.textContent = msg;
    el.loginError.classList.remove('hidden');
  }

  async function ensureAnonSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user?.is_anonymous) return session;
    if (session) await sb.auth.signOut();                         // 익명이 아닌 세션(교사 등)은 정리
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    return data.session;
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    const school = el.inSchool.value.trim();
    const studentNo = el.inStudentNo.value.trim();
    const name = el.inName.value.trim();
    const consent = el.inConsent.checked;

    if (!school || !studentNo || !name) return showLoginError('학교, 학번, 이름을 모두 입력해 주세요.');
    if (!consent) return showLoginError('개인정보 수집·이용에 동의해야 참여할 수 있어요.');

    el.loginSubmit.disabled = true;
    el.loginSubmit.textContent = '확인 중…';
    try {
      await ensureAnonSession();
      const { data, error } = await sb.rpc('claim_student', {
        p_school: school, p_student_no: studentNo, p_name: name, p_consent: consent,
      });
      if (error) {
        const { code, message } = errInfo(error);
        if (code === 'NAME_MISMATCH') return showLoginError(message);
        return showLoginError(message);
      }
      state.me = data;
      localStorage.setItem(LS_STUDENT, JSON.stringify(data));
      el.deviceBanner.classList.add('hidden');
      await loadMyLikes();
      renderAll();
      el.loginDialog.close();
      toast(`${data.name}님, 환영해요! 마음에 드는 작품에 하트를 눌러 주세요.`);
    } catch (err) {
      console.error(err);
      const msg = /rate limit/i.test(err?.message || '')
        ? '지금 접속이 많아요. 잠시 후 다시 시도해 주세요.'
        : '로그인 중 문제가 생겼어요. 네트워크를 확인하고 다시 시도해 주세요.';
      showLoginError(msg);
    } finally {
      el.loginSubmit.disabled = false;
      el.loginSubmit.textContent = '참여하기';
    }
  }

  async function handleLogout() {
    await sb.auth.signOut();
    state.me = null;
    state.myLikes = new Set();
    localStorage.removeItem(LS_STUDENT);
    el.deviceBanner.classList.add('hidden');
    renderAll();
    toast('로그아웃했어요.');
  }

  // 서버가 "로그인이 필요함"이라고 답한 경우(다른 기기에서 로그인 등) 공통 처리
  function handleNotLoggedIn() {
    state.me = null;
    state.myLikes = new Set();
    renderAll();
    detectDeviceUnlink();
    openLogin();
  }

  // ───────────────────────── 하트 (낙관적 업데이트) ─────────────────────────

  function setLikeLocal(id, liked, count) {
    const s = stat(id);
    state.stats.set(id, { like_count: count, comment_count: s.comment_count });
    if (liked) state.myLikes.add(id); else state.myLikes.delete(id);
  }

  async function toggleHeart(id) {
    if (!state.settings.voting_open) return toast('지금은 투표 기간이 아니에요.');
    if (!state.me) return openLogin();
    if (state.pending.has(id)) return;
    state.pending.add(id);

    const wasLiked = state.myLikes.has(id);
    const before = stat(id).like_count;

    // 1) 화면 먼저 바꾸기
    setLikeLocal(id, !wasLiked, Math.max(0, before + (wasLiked ? -1 : 1)));
    refreshCard(id, !wasLiked);

    // 2) 서버에 반영
    const { data, error } = await sb.rpc('toggle_like', { p_artwork_id: id });
    state.pending.delete(id);

    if (error) {
      // 3) 실패하면 되돌리기
      setLikeLocal(id, wasLiked, before);
      refreshCard(id, false);
      const { code, message } = errInfo(error);
      if (code === 'NOT_LOGGED_IN') return handleNotLoggedIn();
      if (code === 'VOTING_CLOSED') { state.settings.voting_open = false; renderAll(); }
      return toast(message);
    }
    // 서버가 알려준 최종 값으로 맞춤
    setLikeLocal(id, data.liked, Number(data.count));
    refreshCard(id, false);
  }

  // ───────────────────────── 작품 상세 모달 ─────────────────────────

  async function openDetail(id) {
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    state.detailId = id;
    state.comments = [];

    el.detailImage.src = imageUrl(a.image_path);
    el.detailImage.alt = a.title;
    el.detailTitle.textContent = a.title;
    el.detailAuthor.textContent = a.author;
    el.detailDesc.textContent = a.description;
    el.commentList.innerHTML = '';
    el.commentEmpty.classList.add('hidden');
    el.commentInput.value = '';
    updateCommentLen();
    renderDetailState();

    if (!el.detailDialog.open) el.detailDialog.showModal();
    el.detailDialog.querySelector('.detail-info').scrollTop = 0;

    await loadComments(id);
  }

  function closeDetail() {
    state.detailId = null;
    el.detailDialog.close();
  }

  // 투표 상태·로그인 상태에 따라 상세 화면의 하트/댓글 입력란 표시 전환
  function renderDetailState() {
    const open = !!state.settings.voting_open;
    el.detailHeart.classList.toggle('hidden', !open);
    el.detailClosed.classList.toggle('hidden', open);
    refreshDetailHeart(false);

    el.commentForm.classList.toggle('hidden', !(open && state.me));
    el.commentClosedNote.classList.toggle('hidden', open);
    el.commentLoginNote.classList.toggle('hidden', !(open && !state.me));
    renderComments();
  }

  function refreshDetailHeart(animate) {
    const id = state.detailId;
    if (!id) return;
    const liked = state.myLikes.has(id);
    el.detailHeart.classList.toggle('is-liked', liked);
    el.detailHeart.setAttribute('aria-pressed', String(liked));
    el.detailHeart.querySelector('.heart-count').textContent = stat(id).like_count;
    el.detailClosed.textContent = `투표 마감 · ♥ ${stat(id).like_count}`;
    if (animate) {
      el.detailHeart.classList.remove('pop');
      void el.detailHeart.offsetWidth;          // 애니메이션 재시작 트릭
      el.detailHeart.classList.add('pop');
    }
  }

  async function loadComments(id) {
    const { data, error } = await sb
      .from('comments')
      .select('id, student_id, body, masked_name, created_at')
      .eq('artwork_id', id)
      .order('created_at', { ascending: true });
    if (state.detailId !== id) return;           // 그 사이 다른 작품을 열었으면 무시
    if (error) { console.warn(error); toast('댓글을 불러오지 못했어요.'); return; }
    state.comments = data || [];
    // 서버에서 가져온 실제 개수로 통계 보정
    state.stats.set(id, { like_count: stat(id).like_count, comment_count: state.comments.length });
    renderComments();
    refreshCard(id, false);
  }

  function renderComments() {
    const list = state.comments;
    el.commentCount.textContent = list.length ? `${list.length}` : '';
    el.commentEmpty.classList.toggle('hidden', list.length > 0);
    el.commentList.innerHTML = list.map((c) => {
      const mine = state.me && c.student_id === state.me.id;
      return `
        <li class="comment-item">
          <div class="comment-main">
            <span class="comment-name">${esc(c.masked_name)}</span>
            <span class="comment-time">${fmtTime(c.created_at)}</span>
            <p class="comment-body">${esc(c.body)}</p>
          </div>
          ${mine ? `<button class="comment-del" type="button" data-del="${c.id}">삭제</button>` : ''}
        </li>`;
    }).join('');
  }

  function updateCommentLen() {
    const n = el.commentInput.value.length;
    el.commentLen.textContent = `${n} / 200`;
    el.commentLen.classList.toggle('over', n >= 200);
  }

  async function handleCommentSubmit(ev) {
    ev.preventDefault();
    const id = state.detailId;
    const body = el.commentInput.value.trim();
    if (!id) return;
    if (!body) return toast('댓글 내용을 입력해 주세요.');
    if (body.length > 200) return toast('댓글은 200자까지 쓸 수 있어요.');
    if (!state.me) return openLogin();

    el.commentSubmit.disabled = true;
    const { data, error } = await sb.rpc('add_comment', { p_artwork_id: id, p_body: body });
    el.commentSubmit.disabled = false;

    if (error) {
      const { code, message } = errInfo(error);
      if (code === 'NOT_LOGGED_IN') return handleNotLoggedIn();
      if (code === 'VOTING_CLOSED') { state.settings.voting_open = false; renderAll(); }
      return toast(message);
    }
    state.comments.push(data);
    el.commentInput.value = '';
    updateCommentLen();
    state.stats.set(id, { like_count: stat(id).like_count, comment_count: state.comments.length });
    renderComments();
    refreshCard(id, false);
    el.commentList.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function handleCommentDelete(commentId) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const { error } = await sb.rpc('delete_my_comment', { p_comment_id: commentId });
    if (error) {
      const { code, message } = errInfo(error);
      if (code === 'NOT_LOGGED_IN') return handleNotLoggedIn();
      return toast(message);
    }
    const id = state.detailId;
    state.comments = state.comments.filter((c) => c.id !== commentId);
    if (id) {
      state.stats.set(id, { like_count: stat(id).like_count, comment_count: state.comments.length });
      renderComments();
      refreshCard(id, false);
    }
    toast('댓글을 삭제했어요.');
  }

  // ───────────────────────── 이벤트 연결 ─────────────────────────

  el.loginBtn.addEventListener('click', openLogin);
  el.logoutBtn.addEventListener('click', handleLogout);
  el.loginForm.addEventListener('submit', handleLogin);
  el.retryBtn.addEventListener('click', loadAll);
  el.commentLoginBtn.addEventListener('click', openLogin);
  el.commentForm.addEventListener('submit', handleCommentSubmit);
  el.commentInput.addEventListener('input', updateCommentLen);
  el.detailHeart.addEventListener('click', () => state.detailId && toggleHeart(state.detailId));

  // 정렬 버튼
  document.querySelectorAll('.sort-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.sort = b.dataset.sort;
      sessionStorage.setItem(SS_SORT, state.sort);
      renderGallery();
    });
  });

  // 갤러리: 하트 / 상세 열기 (이벤트 위임)
  el.gallery.addEventListener('click', (ev) => {
    const heart = ev.target.closest('[data-heart]');
    if (heart) return toggleHeart(heart.dataset.heart);
    const open = ev.target.closest('[data-open]');
    if (open) return openDetail(open.dataset.open);
  });

  // 댓글 삭제 (이벤트 위임)
  el.commentList.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) handleCommentDelete(del.dataset.del);
  });

  // 모달 닫기 버튼 + 바깥(배경) 클릭으로 닫기
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      const d = $(b.dataset.close);
      if (d === el.detailDialog) closeDetail(); else d.close();
    });
  });
  [el.loginDialog, el.detailDialog].forEach((d) => {
    d.addEventListener('click', (ev) => {
      if (ev.target === d) { if (d === el.detailDialog) closeDetail(); else d.close(); }
    });
    d.addEventListener('close', () => { if (d === el.detailDialog) state.detailId = null; });
  });

  // 탭을 다시 보면 투표 상태를 새로 확인 (교사가 마감하면 곧 반영되도록)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.artworks.length) return;
    try {
      const wasOpen = state.settings.voting_open;
      await Promise.all([loadSettings(), loadStats()]);
      if (wasOpen !== state.settings.voting_open) renderAll();
      else state.artworks.forEach((a) => refreshCard(a.id, false));
    } catch (_) { /* 조용히 무시 */ }
  });

  // 시작!
  loadAll();
})();
