// =====================================================================
//  Supabase 접속 설정
// =====================================================================
//  * SUPABASE_URL      : Supabase 대시보드 → Project Settings → API → Project URL
//  * SUPABASE_ANON_KEY : 같은 화면의 "anon public" (또는 publishable) key
//
//  ★ 이 파일은 GitHub Pages 에 그대로 공개됩니다.
//    anon key 는 공개되어도 괜찮도록 설계된 키입니다. (RLS 가 데이터를 보호합니다)
//    service_role / secret key 는 절대로 여기에 넣지 마세요.
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://vbxgwziwmizdoimufgpi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZieGd3eml3bWl6ZG9pbXVmZ3BpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MjMwODAsImV4cCI6MjEwNjk5OTA4MH0.WW94eWVHSSgOELCIZofGsZQVwvov9Z6v-q0C12IJ0_0',

  // 작품 이미지가 들어 있는 Storage 버킷 이름 (schema.sql 과 같아야 함)
  BUCKET: 'artworks',
};
